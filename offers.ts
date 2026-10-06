/**
 * Vast.ai's marketplace, read from the public `GET /api/v0/bundles/`: no key,
 * the query is URL-encoded JSON in `q` (the same call `vastcpu` makes).
 *
 * Every response stops at 64 offers whatever `limit` says, so a search runs
 * under three sort orders and merges on `ask_contract_id`. The server's
 * `dph_total` filter matches the rate before the storage charge; asking with
 * `allocated_storage` makes `dph_total` include the disk, and the price is
 * checked again here against the total the renter pays.
 */

import { z } from "zod";
import { type CpuIndex, compact, cpuPerf, shortCpuName } from "./cpu-score";
import { type Fetch, field, SERVER, text } from "./vast-api";

const BUNDLES_URL = `${SERVER}/api/v0/bundles/`;
const TIMEOUT_MS = 30_000;
/** The disk, in GB, a search prices when the caller names none. */
const DEFAULT_DISK_GB = 10;
const ORDERS: readonly (readonly [string, "asc" | "desc"])[] = [
  ["dph_total", "asc"],
  ["reliability", "desc"],
  ["cpu_cores_effective", "desc"],
];

/** One offer: only what is shown and judged. A row without an id or a price is not an offer. */
export const OfferSchema = z.object({
  ask_contract_id: z.number(),
  dph_total: z.number(),
  machine_id: field(z.number()),
  gpu_name: field(text),
  num_gpus: field(z.number()),
  /** The share of the machine's GPUs the offer rents: 1 is the whole machine. */
  gpu_frac: field(z.number()),
  /** MB, one GPU's. */
  gpu_ram: field(z.number()),
  cpu_cores_effective: field(z.number()),
  /** MB. */
  cpu_ram: field(z.number()),
  /** GB the host has free. */
  disk_space: field(z.number()),
  reliability: field(z.number()),
  geolocation: field(text.nullable()),
  /** Mbps. */
  inet_down: field(z.number()),
  /** Vast's score for the whole rental's GPUs. */
  dlperf: field(z.number()),
  total_flops: field(z.number()),
  /** GB/s, one GPU's memory. */
  gpu_mem_bw: field(z.number()),
  /** The host's CPU as the host names it: "XEON® PLATINUM 8563C". */
  cpu_name: field(text),
  /** The whole machine's threads; `cpu_cores_effective` is the offer's. */
  cpu_cores: field(z.number()),
  /** "verified", "unverified" or "deverified". */
  verification: field(text),
  rentable: field(z.boolean()),
  /** Epoch seconds: the host's end date; Vast stops a rented box then. */
  end_date: field(z.number()),
  /** Seconds left until `end_date`, as of the search. */
  duration: field(z.number()),
});
export type Offer = z.infer<typeof OfferSchema>;

export type OfferFilters = {
  /** A substring of the GPU's name, any case. */
  gpu?: string | undefined;
  minVramGb?: number | undefined;
  minCpuCores?: number | undefined;
  minRamGb?: number | undefined;
  minDiskGb?: number | undefined;
  maxDph?: number | undefined;
  minReliability: number;
  /** A substring of the location, any case: "SE", "Sweden", "US". */
  region?: string | undefined;
  minInetDownMbps?: number | undefined;
  /** Hours the box must stay rentable: the host's end date is at least this far off. */
  minHours?: number | undefined;
  limit: number;
};

async function bundles(query: Record<string, unknown>, get: Fetch): Promise<Offer[]> {
  const url = `${BUNDLES_URL}?${new URLSearchParams({ q: JSON.stringify(query) })}`;
  const response = await get(url, {
    headers: { "User-Agent": "prifly-ext-vastai" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Vast.ai offer search failed (${response.status})`);
  const body = z.object({ offers: z.array(z.unknown()) }).safeParse(await response.json());
  if (!body.success) throw new Error("Vast.ai sent an offer list this extension cannot read");
  return body.data.offers.flatMap((row) => {
    const offer = OfferSchema.safeParse(row);
    return offer.success ? [offer.data] : [];
  });
}

/** The server-side half of a search; the rest is checked locally in `matches`. */
function queryOf(filters: OfferFilters): Record<string, unknown> {
  const { minVramGb, minCpuCores, minRamGb, minDiskGb, maxDph, minInetDownMbps, minHours } =
    filters;
  return {
    rentable: { eq: true },
    num_gpus: { gte: 1 },
    reliability: { gte: filters.minReliability },
    ...(minVramGb === undefined ? {} : { gpu_ram: { gte: minVramGb * 1000 } }),
    ...(minCpuCores === undefined ? {} : { cpu_cores_effective: { gte: minCpuCores } }),
    ...(minRamGb === undefined ? {} : { cpu_ram: { gte: minRamGb * 1000 } }),
    ...(minDiskGb === undefined ? {} : { disk_space: { gte: minDiskGb } }),
    ...(maxDph === undefined ? {} : { dph_total: { lte: maxDph } }),
    ...(minInetDownMbps === undefined ? {} : { inet_down: { gte: minInetDownMbps } }),
    ...(minHours === undefined ? {} : { duration: { gte: minHours * 3600 } }),
    allocated_storage: minDiskGb ?? DEFAULT_DISK_GB,
    limit: 64,
    type: "ask",
  };
}

/** Whether an offer passes every filter, including those the server only half applies. */
export function matches(offer: Offer, filters: OfferFilters): boolean {
  const { gpu, minVramGb, minCpuCores, minRamGb, minDiskGb, maxDph, region } = filters;
  const below = (value: number | undefined, least: number | undefined, unit = 1) =>
    least !== undefined && (value ?? 0) < least * unit;
  if (offer.rentable === false) return false;
  // An offer with no end date has no limit to fail.
  if (filters.minHours !== undefined && (offer.duration ?? Infinity) < filters.minHours * 3600) {
    return false;
  }
  if (maxDph !== undefined && offer.dph_total > maxDph) return false;
  if ((offer.reliability ?? 0) < filters.minReliability) return false;
  if (gpu !== undefined && !(offer.gpu_name ?? "").toLowerCase().includes(gpu.toLowerCase())) {
    return false;
  }
  if (
    region !== undefined &&
    !(offer.geolocation ?? "").toLowerCase().includes(region.toLowerCase())
  ) {
    return false;
  }
  return !(
    below(offer.gpu_ram, minVramGb, 1000) ||
    below(offer.cpu_cores_effective, minCpuCores) ||
    below(offer.cpu_ram, minRamGb, 1000) ||
    below(offer.disk_space, minDiskGb) ||
    below(offer.inet_down, filters.minInetDownMbps)
  );
}

/** Whether the host's end date falls before `hours` of running plus an hour's margin from `nowMs`. */
export function endsTooSoon(offer: Offer, hours: number, nowMs: number): boolean {
  return offer.end_date != null && offer.end_date * 1000 < nowMs + (hours + 1) * 3_600_000;
}

/** How long until the offer's end date, as of `nowMs`: "3 d 4 h", "9 h", "40 min"; null with no end date. */
export function timeLeft(offer: Offer, nowMs: number): string | null {
  if (offer.end_date == null) return null;
  const minutes = Math.max(0, Math.floor((offer.end_date * 1000 - nowMs) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  return hours >= 1 ? `${hours} h` : `${minutes} min`;
}

/** `timeLeft` as a phrase: "ends in 3 d 4 h", "no end date". */
export function endsInText(offer: Offer, nowMs: number): string {
  const left = timeLeft(offer, nowMs);
  return left === null ? "no end date" : `ends in ${left}`;
}

/** The VRAM of all the offer's GPUs: `gpu_ram` is one card's. */
export function vramText(offer: Offer): string {
  if (offer.gpu_ram === undefined) return "?";
  const gpus = offer.num_gpus ?? 1;
  const each = Math.round(offer.gpu_ram / 1000);
  return gpus > 1 ? `${gpus * each} GB (${gpus} × ${each})` : `${each} GB`;
}

/**
 * How much of the host the offer rents. `gpu_frac` is its share of the
 * machine's GPUs, and its cores, RAM and disk are the machine's times that.
 */
export function shareText(offer: Offer): string {
  const frac = offer.gpu_frac;
  if (frac === undefined || frac <= 0) return "?";
  if (frac >= 1) return "whole machine";
  const gpus = offer.num_gpus ?? 1;
  return `${gpus} of ${Math.round(gpus / frac)} GPUs`;
}

/** The VRAM for a card: "8 × 98 GB", "24 GB". */
export function vramCell(offer: Offer): string {
  if (offer.gpu_ram === undefined) return "?";
  const gpus = offer.num_gpus ?? 1;
  const each = Math.round(offer.gpu_ram / 1000);
  return gpus > 1 ? `${gpus} × ${each} GB` : `${each} GB`;
}

/** The GPU for a card: "8x RTX PRO 6000 S", "2x RTX 4090 · 2 of 4" when the offer is part of the machine. */
export function gpuCell(offer: Offer): string {
  const gpus = (offer.num_gpus ?? 1) > 1 ? `${offer.num_gpus}x ` : "";
  const part = offer.gpu_frac !== undefined && offer.gpu_frac > 0 && offer.gpu_frac < 1;
  return `${gpus}${offer.gpu_name ?? "?"}${part ? ` · ${shareText(offer).replace(/ GPUs$/, "")}` : ""}`;
}

/** The card's "Ends in": whole days "14 d", under a day whole hours "7 h", under an hour "<1 h", "no end date". */
export function endsCell(offer: Offer, nowMs: number): string {
  if (offer.end_date == null) return "no end date";
  const hours = Math.max(0, Math.floor((offer.end_date * 1000 - nowMs) / 3_600_000));
  if (hours >= 24) return `${Math.floor(hours / 24)} d`;
  return hours >= 1 ? `${hours} h` : "<1 h";
}

/** Where an offer is: the ISO 3166-1 alpha-2 code Vast ends its `geolocation` with, and the place spelled out. */
export type Place = {
  /** "NO"; null when `geolocation` carries none. */
  code: string | null;
  /** The cell without a flag: Vast's text as it is ("Norway, NO"), "?" when there is none. */
  text: string;
  /** The hover text: "Norway", "British Columbia, Canada"; null when there is no code to spell out. */
  full: string | null;
};

const REGIONS = new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });

/** Read an offer's `geolocation`: "Norway, NO" → code NO, place "Norway". */
export function placeOf(geolocation: string | null | undefined): Place {
  const text = geolocation?.trim() ?? "";
  if (text === "") return { code: null, text: "?", full: null };
  const parts = text.split(",").map((part) => part.trim());
  const code = parts.pop() ?? "";
  const none = { code: null, text, full: null };
  if (!/^[A-Z]{2}$/.test(code)) return none;
  let country: string | undefined;
  try {
    country = REGIONS.of(code);
  } catch {
    return none;
  }
  // An unknown code comes back as itself, ZZ as "Unknown Region": there is no country to spell out.
  if (country === undefined || country === code || country === "Unknown Region") return none;
  const area = parts.filter((part) => part !== "").join(", ");
  return { code, text, full: area === "" || area === country ? country : `${area}, ${country}` };
}

const VERIFICATION: Readonly<Record<string, string>> = {
  verified: "yes",
  deverified: "lost",
  unverified: "no",
};

/** `value` per dollar an hour at the offer's rate as the card shows it (disk included), or "–" with no value. */
function perDollar(value: number | null, offer: Offer, show: (n: number) => string): string {
  return value === null ? "–" : show(value / offer.dph_total);
}

/** The cells the card and the offer list share: GPU and CPU performance, each per $/h, memory bandwidth, download speed, verification. */
export function perfCells(offer: Offer, cpus: CpuIndex) {
  const gpuPerf = offer.dlperf ?? null;
  const cpu = cpuPerf(offer, cpus);
  const whole = (n: number | undefined) => (n === undefined ? "?" : String(Math.round(n)));
  return {
    gpuPerf: whole(gpuPerf ?? undefined),
    gpuPerDollar: perDollar(gpuPerf, offer, (n) => String(Math.round(n))),
    memBandwidth: whole(offer.gpu_mem_bw),
    cpu: `${Math.round(offer.cpu_cores_effective ?? 0)} × ${offer.cpu_name === undefined ? "?" : shortCpuName(offer.cpu_name)}`,
    cpuPerf: cpu === null ? "unscored" : compact(cpu),
    cpuPerDollar: perDollar(cpu, offer, compact),
    down: whole(offer.inet_down),
    verified: VERIFICATION[offer.verification ?? ""] ?? "?",
  };
}

/** The cheapest offers that pass the filters, cheapest first, at most `limit`. */
export async function searchOffers(filters: OfferFilters, get: Fetch = fetch): Promise<Offer[]> {
  const base = queryOf(filters);
  const pages = await Promise.allSettled(
    ORDERS.map((order) => bundles({ ...base, order: [order] }, get)),
  );
  const failed = pages.flatMap((page) => (page.status === "rejected" ? [page.reason] : []));
  // One page failing leaves a smaller pool; all of them failing is the answer.
  if (failed.length === pages.length) {
    throw failed[0] instanceof Error ? failed[0] : new Error(String(failed[0]));
  }
  const pool = new Map<number, Offer>();
  for (const page of pages) {
    if (page.status === "fulfilled") for (const o of page.value) pool.set(o.ask_contract_id, o);
  }
  return [...pool.values()]
    .filter((offer) => matches(offer, filters))
    .sort((a, b) => a.dph_total - b.dph_total)
    .slice(0, filters.limit);
}

/** One offer as it is now, for today's price; null when it is gone or no longer rentable. */
export async function fetchOffer(
  id: number,
  diskGb: number,
  get: Fetch = fetch,
): Promise<Offer | null> {
  const found = await bundles(
    {
      ask_contract_id: { eq: id },
      rentable: { eq: true },
      allocated_storage: diskGb,
      limit: 5,
      type: "ask",
    },
    get,
  );
  const offer = found.find((o) => o.ask_contract_id === id);
  return offer === undefined || offer.rentable === false ? null : offer;
}
