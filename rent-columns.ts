/**
 * The columns of the `vast_rent` card. Each is defined once, with its cell, link,
 * hover title and kind, and shown only for the needs it matters to, so rows,
 * links, titles and kinds always line up with the columns the card shows.
 */

import { type CpuIndex, cpuLink } from "./cpu-score";
import { gpuLink } from "./gpu-link";
import { endsCell, gpuCell, type Offer, type perfCells, placeOf, vramCell } from "./offers";
import { cardRate } from "./tool-kit";

/** What the work is bound by. */
export const NEEDS = ["gpu", "cpu", "io"] as const;

/** What the work is bound by: which performance columns the card keeps. */
export type Need = (typeof NEEDS)[number];

/** What one card column holds for one offer. `link`, `title` and `kind` are null where the cell has none. */
export type Cell = {
  text: string;
  link?: string | null;
  title?: string | null;
  kind?: "flag" | "link-icon" | null;
};

/** What a column needs to build a cell: the offer, the budget, the clock, the CPU scores and what the prifly draws. */
export type CellInput = {
  offer: Offer;
  budget: number;
  now: number;
  cpus: CpuIndex;
  perf: ReturnType<typeof perfCells>;
  flags: boolean;
  offerLink: boolean;
};

export type Column = {
  name: string;
  /** The needs this column is shown for. */
  needs: readonly Need[];
  cell: (input: CellInput) => Cell;
};

const ALL: readonly Need[] = ["gpu", "cpu", "io"];
const GPU_ONLY: readonly Need[] = ["gpu"];
const NOT_IO: readonly Need[] = ["gpu", "cpu"];

const gb = (mb: number | undefined) => (mb === undefined ? "?" : `${Math.round(mb / 1000)} GB`);

/** Every column once, in card order, with the needs it is shown for. */
const CARD_COLUMNS: readonly Column[] = [
  {
    name: "GPU",
    needs: GPU_ONLY,
    cell: ({ offer }) => ({ text: gpuCell(offer), link: gpuLink(offer.gpu_name) }),
  },
  { name: "VRAM", needs: GPU_ONLY, cell: ({ offer }) => ({ text: vramCell(offer) }) },
  {
    name: "GPU perf · /$",
    needs: GPU_ONLY,
    cell: ({ perf }) => ({
      text: perf.gpuPerf === "?" ? "–" : `${perf.gpuPerf} · ${perf.gpuPerDollar}`,
    }),
  },
  { name: "Mem GB/s", needs: GPU_ONLY, cell: ({ perf }) => ({ text: perf.memBandwidth }) },
  {
    name: "CPU",
    needs: ALL,
    cell: ({ offer, cpus, perf }) => ({ text: perf.cpu, link: cpuLink(offer, cpus) }),
  },
  {
    name: "CPU perf · /$",
    needs: NOT_IO,
    cell: ({ perf }) => ({
      text: perf.cpuPerf === "unscored" ? "–" : `${perf.cpuPerf} · ${perf.cpuPerDollar}`,
    }),
  },
  { name: "RAM", needs: ALL, cell: ({ offer }) => ({ text: gb(offer.cpu_ram) }) },
  {
    name: "Disk",
    needs: ALL,
    cell: ({ offer }) => ({ text: `${Math.round(offer.disk_space ?? 0)} GB` }),
  },
  { name: "Mbps", needs: ALL, cell: ({ perf }) => ({ text: perf.down }) },
  { name: "$/h", needs: ALL, cell: ({ offer }) => ({ text: cardRate(offer.dph_total) }) },
  {
    name: "Hours",
    needs: ALL,
    cell: ({ offer, budget }) => ({ text: (budget / offer.dph_total).toFixed(1) }),
  },
  { name: "Ends in", needs: ALL, cell: ({ offer, now }) => ({ text: endsCell(offer, now) }) },
  {
    name: "Rel.",
    needs: ALL,
    cell: ({ offer }) => ({ text: (offer.reliability ?? 0).toFixed(3) }),
  },
  { name: "Verified", needs: ALL, cell: ({ perf }) => ({ text: perf.verified }) },
  {
    name: "Where",
    needs: ALL,
    cell: ({ offer, flags }) => {
      const place = placeOf(offer.geolocation);
      return {
        text: flags && place.code !== null ? place.code : place.text,
        title: place.code !== null ? place.full : null,
        kind: place.code !== null ? "flag" : null,
      };
    },
  },
  {
    name: "Offer",
    needs: ALL,
    cell: ({ offer, offerLink }) => ({
      text: String(offer.ask_contract_id),
      link: offerUrl(offer),
      title: `Offer ${offer.ask_contract_id} on Vast.ai`,
      kind: offerLink ? "link-icon" : null,
    }),
  },
];

/** The columns the card shows for this need. */
export function columnsFor(need: Need): readonly Column[] {
  return CARD_COLUMNS.filter((column) => column.needs.includes(need));
}

/** Vast's console, on one offer. Unverified: the console is a single-page app and may ignore `ask`. */
export function offerUrl(offer: Offer): string {
  return `https://cloud.vast.ai/?ask=${offer.ask_contract_id}`;
}
