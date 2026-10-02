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
  /** MB. */
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
  rentable: field(z.boolean()),
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
  const { minVramGb, minCpuCores, minRamGb, minDiskGb, maxDph, minInetDownMbps } = filters;
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
