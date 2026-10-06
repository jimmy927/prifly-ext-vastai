/**
 * A CPU score for an offer: PassMark's multithread CPU Mark of the chip,
 * divided by the chip's thread count, times `cpu_cores_effective` (the threads
 * the renter gets; `cpu_cores` is the whole machine). Skill rules VAI-20 to 23.
 *
 * The marks come from cpubenchmark.net's `high_end_cpus.html`, fetched with a
 * browser User-Agent (a bare one gets 403) and kept in memory for 24 hours.
 * PassMark's page has no thread counts, so `THREADS` holds them for the chips
 * that rent often. A chip missing from the page or from `THREADS` is
 * unscored: never a core-count stand-in (VAI-22), and a failed fetch leaves
 * every chip unscored rather than failing a rent.
 *
 * VAI-21, sanity check: PassMark sometimes measures a chip on a cloud slice
 * (its EPYC 9K84 entry ran on 16 threads), and a wrong thread count scales
 * the whole ranking. `THREADS` is the chip's real count from its spec sheet,
 * never the thread count of a PassMark run.
 */

import type { Fetch } from "./vast-api";

const PAGE = "https://www.cpubenchmark.net/high_end_cpus.html";
const SITE = "https://www.cpubenchmark.net/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const TTL_MS = 24 * 3_600_000;
const TIMEOUT_MS = 15_000;

export type Chip = { name: string; mark: number; url: string };

/** The chips of PassMark's page by normalised model key. */
export type CpuIndex = ReadonlyMap<string, Chip>;

const DROPPED = new Set(["intel", "amd", "processor", "cpu", "gen", "genuine"]);

/** Words of a CPU name that identify the model: "XEON® PLATINUM 8563C" and "Intel Xeon Platinum 8563C" both give "xeon platinum 8563c". */
export function modelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[®™]|\((?:r|tm)\)/g, " ")
    .replace(/@.*$/, "")
    .replace(/\b\d+-cores?\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, " ")
    .split(/[^a-z0-9+]+/)
    .filter((word) => word !== "" && !DROPPED.has(word))
    .join(" ");
}

const SHORT_WORDS: Record<string, string> = {
  XEON: "Xeon",
  PLATINUM: "Plat.",
  GOLD: "Gold",
  SILVER: "Silver",
  BRONZE: "Bronze",
  RYZEN: "Ryzen",
  CORE: "Core",
};

/** A CPU name for a table cell: "XEON® PLATINUM 8563C" → "Xeon Plat. 8563C", "AMD EPYC 7742 64-Core Processor" → "EPYC 7742", "Ryzen Threadripper PRO 5975WX" → "TR PRO 5975WX". */
export function shortCpuName(name: string): string {
  return name
    .replace(/[®™]|\((?:r|tm)\)/gi, "")
    .replace(/@.*$/, "")
    .replace(/\bCPU\s*$/i, "")
    .replace(/\b\d+-cores?\b/gi, "")
    .replace(/\bprocessor\b/gi, "")
    .replace(/\b(?:ryzen\s+)?threadripper\b/gi, "TR")
    .split(/\s+/)
    .filter((word) => word !== "" && !/^(?:intel|amd|cpu)$/i.test(word))
    .map((word) => SHORT_WORDS[word] ?? word)
    .join(" ");
}

/** The chips of PassMark's page: name, CPU Mark and the link to its page. */
export function parseChips(html: string): Chip[] {
  const chips: Chip[] = [];
  const row =
    /<a href="\/(cpu\.php\?cpu=[^"]+)"><span class="prdname">([^<]+)<\/span>.*?<span class="count">([\d,]+)<\/span>/g;
  for (const [, path, name, count] of html.matchAll(row)) {
    if (path === undefined || name === undefined || count === undefined) continue;
    const mark = Number(count.replace(/,/g, ""));
    if (!Number.isFinite(mark)) continue;
    chips.push({
      name: name.replace(/&amp;/g, "&"),
      mark,
      url: SITE + path.replace(/&amp;/g, "&"),
    });
  }
  return chips;
}

/** The chips by model key; where two share a key the first (the higher mark on the page) stays. */
export function indexChips(chips: readonly Chip[]): CpuIndex {
  const index = new Map<string, Chip>();
  for (const chip of chips) {
    const key = modelKey(chip.name);
    if (!index.has(key)) index.set(key, chip);
  }
  return index;
}

/** Threads per chip, by family prefix: [prefix, threads, model numbers]. Spec-sheet values (cores × 2 where SMT is on). */
const FAMILIES: readonly (readonly [string, number, string])[] = [
  // EPYC Rome 7xx2
  ["epyc", 16, "7232p 7252 7262"],
  ["epyc", 24, "7272"],
  ["epyc", 32, "7282 7302 7302p"],
  ["epyc", 48, "7352 7402 7402p"],
  ["epyc", 64, "7452 7502 7502p 7532 7542"],
  ["epyc", 96, "7552 7642"],
  ["epyc", 128, "7662 7702 7702p 7742 7h12"],
  // EPYC Milan 7xx3
  ["epyc", 16, "7203 7203p 72f3"],
  ["epyc", 32, "7303 7303p 7313 7313p 7343 7373x 73f3"],
  ["epyc", 48, "7413 7443 7443p 7473x 74f3"],
  ["epyc", 56, "7453"],
  ["epyc", 64, "7513 7543 7543p 7573x 75f3"],
  ["epyc", 96, "7643"],
  ["epyc", 112, "7663"],
  ["epyc", 128, "7713 7763 7713p"],
  // EPYC Genoa and Bergamo 9xx4
  ["epyc", 32, "9124 9174f 9184x"],
  ["epyc", 48, "9224 9254 9274f"],
  ["epyc", 64, "9334 9354 9384x 9354p"],
  ["epyc", 96, "9434 9454 9474f"],
  ["epyc", 128, "9534 9554 9574f"],
  ["epyc", 168, "9634"],
  ["epyc", 192, "9654 9654p 9684x"],
  ["epyc", 224, "9734"],
  ["epyc", 256, "9754 9754s"],
  // EPYC Turin 9xx5
  ["epyc", 32, "9135 9175f"],
  ["epyc", 48, "9255"],
  ["epyc", 64, "9355"],
  ["epyc", 96, "9455 9475f"],
  ["epyc", 128, "9555 9575f"],
  ["epyc", 144, "9565"],
  ["epyc", 192, "9655"],
  ["epyc", 256, "9745 9755"],
  ["epyc", 288, "9825"],
  ["epyc", 320, "9845"],
  ["epyc", 384, "9965"],
  // Xeon Gold: Sapphire Rapids, Emerald Rapids, Ice Lake, Cascade Lake
  ["xeon gold", 16, "6434 5415+ 5515+ 6534"],
  ["xeon gold", 32, "6426y 6444y 5416s 6526y 6544y 6326 6226r"],
  ["xeon gold", 36, "6416h 6354"],
  ["xeon gold", 40, "6248 6230"],
  ["xeon gold", 48, "6418h 6442y 5418y 5412u 5411n 6542y 6342 6336y 6252"],
  ["xeon gold", 56, "5420+ 5520+ 5512u 6348 6330"],
  [
    "xeon gold",
    64,
    "6414u 6420+ 6430 6438y+ 6438n 6448y 6448h 6454s 6458q 6530 6538y+ 6538n 6548y+ 6548n 6338",
  ],
  // Xeon Platinum
  ["xeon platinum", 32, "8444h"],
  ["xeon platinum", 48, "8260"],
  ["xeon platinum", 56, "8450h 8280"],
  ["xeon platinum", 64, "8454h 8460y+ 8462y+ 8358 8562y+"],
  ["xeon platinum", 72, "8452y"],
  ["xeon platinum", 76, "8368"],
  ["xeon platinum", 80, "8460h 8380"],
  ["xeon platinum", 88, "8458p"],
  ["xeon platinum", 96, "8468 8468h 8488c 8558 8558p 8558u 8568y+"],
  ["xeon platinum", 104, "8470 8470q 8471n"],
  ["xeon platinum", 112, "8480+ 8480c 8481c 8570"],
  ["xeon platinum", 120, "8490h 8580"],
  ["xeon platinum", 128, "8592+ 8592v 8593q"],
  // Xeon E5 (v3/v4), common on old hosts
  ["xeon e5", 24, "2670 v3 2680 v3"],
  ["xeon e5", 28, "2680 v4 2690 v4"],
  ["xeon e5", 36, "2686 v4 2697 v4 2699 v3"],
  ["xeon e5", 44, "2699 v4"],
  // Threadripper and Threadripper PRO
  ["ryzen threadripper", 48, "3960x 7960x"],
  ["ryzen threadripper", 64, "3970x 7970x"],
  ["ryzen threadripper", 128, "3990x 7980x"],
  ["ryzen threadripper pro", 24, "5945wx 7945wx 9965wx"],
  ["ryzen threadripper pro", 32, "3955wx 5955wx 7955wx 9955wx"],
  ["ryzen threadripper pro", 48, "5965wx 7965wx"],
  ["ryzen threadripper pro", 64, "3975wx 5975wx 7975wx 9975wx"],
  ["ryzen threadripper pro", 128, "3995wx 5995wx 7985wx 9985wx"],
  ["ryzen threadripper pro", 192, "7995wx 9995wx"],
  // Ryzen 9
  ["ryzen 9", 24, "3900x 5900x 7900x 7900x3d 9900x 9900x3d"],
  ["ryzen 9", 32, "3950x 5950x 7950x 7950x3d 7945hx 9950x 9950x3d"],
];

const THREADS: ReadonlyMap<string, number> = new Map(
  FAMILIES.flatMap(([prefix, threads, models]) =>
    modelList(models).map((model) => [`${prefix} ${model}`, threads] as const),
  ),
);

/** "7232p 7252" → ["7232p", "7252"]; "2670 v3 2680 v3" → ["2670 v3", "2680 v3"]. */
function modelList(text: string): string[] {
  return text.match(/\S+(?: v\d)?/g) ?? [];
}

/** The chip's threads from `THREADS`; the name without a "Xeon" prefix still matches ("EPYC 7742" has none). */
export function threadsOf(cpuName: string): number | undefined {
  return THREADS.get(modelKey(cpuName));
}

/** A cell's CPU perf: the chip's mark per thread times the threads rented; null when the chip is unscored or the offer names no CPU. */
export function cpuPerf(
  offer: { cpu_name?: string | undefined; cpu_cores_effective?: number | undefined },
  index: CpuIndex,
): number | null {
  const { cpu_name: name, cpu_cores_effective: rented } = offer;
  if (name === undefined || rented === undefined) return null;
  const chip = index.get(modelKey(name));
  const threads = threadsOf(name);
  if (chip === undefined || threads === undefined) return null;
  return (chip.mark / threads) * rented;
}

/** PassMark's page for the offer's chip; null when it is unscored. */
export function cpuLink(offer: { cpu_name?: string | undefined }, index: CpuIndex): string | null {
  return offer.cpu_name === undefined ? null : (index.get(modelKey(offer.cpu_name))?.url ?? null);
}

/** A score for a table: "812", "9.8k", "107k". */
export function compact(value: number): string {
  if (value >= 100_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

let cached: { at: number; index: CpuIndex } | null = null;
let pending: Promise<CpuIndex> | null = null;

/** Forget the fetched page (tests). */
export function resetCpuScores(): void {
  cached = null;
  pending = null;
}

async function load(get: Fetch): Promise<CpuIndex> {
  const response = await get(PAGE, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`cpubenchmark.net answered ${response.status}`);
  const chips = parseChips(await response.text());
  if (chips.length === 0) throw new Error("cpubenchmark.net's page held no CPU marks");
  return indexChips(chips);
}

/** PassMark's CPU marks, from memory for 24 hours; an empty index (every chip unscored) when the page cannot be read. */
export async function cpuScores(get: Fetch, now: number): Promise<CpuIndex> {
  if (cached !== null && now - cached.at < TTL_MS) return cached.index;
  pending ??= load(get).then(
    (index) => {
      cached = { at: now, index };
      pending = null;
      return index;
    },
    () => {
      pending = null;
      return new Map<string, Chip>();
    },
  );
  return await pending;
}
