/**
 * The New session dialog's rent row (`api.onRent`, host feature
 * "rent-from-dialog"): the same rental as `vast_rent`, with the offers and the
 * budget chosen here instead of by the session.
 */

import { cpuPerf, cpuScores } from "./cpu-score";
import { MAX_AHEAD_MS } from "./leases";
import { type Offer, searchOffers } from "./offers";
import type { RentHandler } from "./prifly-api";
import { type RentArgs, rentOnCard } from "./rent";
import { HOUR_MS, type ToolDeps } from "./tool-kit";
import { listInstances } from "./vast-api";

/** The room above the best offer's price for the whole run that the suggested budget leaves. */
const BUDGET_MARGIN = 1.25;
const DIALOG_OFFERS = 6;
const DIALOG_IMAGE = "ubuntu:22.04";

/**
 * What the dialog's rent row searches for, from the vastai skill: reliability
 * 0.98 (VAI-25), no filter on verification (VAI-26), VRAM filtered when the
 * job needs it (VAI-27). A GPU job ranks cheapest first; a CPU job on CPU perf
 * per $/h (VAI-20), the chips PassMark does not know after the scored ones.
 */
const DIALOG_NEEDS = {
  gpu: {
    filters: { minVramGb: 16, minCpuCores: 4, minRamGb: 16 },
    disk: 40,
    note: "one GPU with at least 16 GB VRAM",
  },
  cpu: {
    filters: { minCpuCores: 8, minRamGb: 16 },
    disk: 20,
    note: "8 or more CPU threads, no GPU work",
  },
} as const;

/** A box name from the purpose: lower-case letters and digits, at most 8, not one an existing box has. */
export function nameFor(purpose: string, taken: ReadonlySet<string>): string {
  const base =
    purpose
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8) || "box";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, 8 - String(n).length)}${n}`;
    if (!taken.has(name)) return name;
  }
}

/** The suggested budget: the best offer's rate for the hours, plus the margin, up to the next cent. */
export function suggestedBudget(rate: number, hours: number): number {
  return Math.ceil(rate * hours * BUDGET_MARGIN * 100 - 1e-6) / 100;
}

/** The best offers for the need, best first. */
async function dialogOffers(
  deps: ToolDeps,
  need: "cpu" | "gpu",
  hours: number,
  disk: number,
): Promise<Offer[]> {
  const found = await searchOffers(
    {
      ...DIALOG_NEEDS[need].filters,
      minDiskGb: disk,
      minReliability: 0.98,
      // What the budget runs, held to the longest lease, plus the hour's margin `endsTooSoon` asks.
      minHours: Math.min(MAX_AHEAD_MS / HOUR_MS, hours * BUDGET_MARGIN) + 1,
      limit: need === "cpu" ? 30 : DIALOG_OFFERS,
    },
    deps.get,
  );
  if (need === "gpu") return found.slice(0, DIALOG_OFFERS);
  const cpus = await cpuScores(deps.get, deps.now());
  // The sort is stable: the unscored, and equal values, stay cheapest first.
  const rank = (offer: Offer) => {
    const perf = cpuPerf(offer, cpus);
    return perf === null ? Number.NEGATIVE_INFINITY : perf / offer.dph_total;
  };
  const better = (a: Offer, b: Offer) => {
    const [x, y] = [rank(a), rank(b)];
    return x === y ? 0 : y > x ? 1 : -1;
  };
  return found.sort(better).slice(0, DIALOG_OFFERS);
}

/**
 * The New session dialog's rent row (`api.onRent`): find the best offers for
 * the need, show the same rent card as `vast_rent` over the request's session
 * with a suggested budget, and create a box labelled for that session. It
 * answers with the box's key, or why nothing was rented; it never throws.
 */
export function rentHandler(deps: ToolDeps): RentHandler {
  return async (req, ui) => {
    try {
      if (!Number.isFinite(req.hours) || req.hours <= 0)
        throw new Error("The hours are not a number above 0.");
      const { disk, note } = DIALOG_NEEDS[req.need];
      const offers = await dialogOffers(deps, req.need, req.hours, disk);
      const best = offers[0];
      if (best === undefined) {
        throw new Error(`No ${req.need} offer passes the filters for ${req.hours} h right now.`);
      }
      const boxes = await listInstances(await deps.keys(), deps.get);
      const taken = new Set(boxes.map((box) => (box.label ?? "").split("/").pop() ?? ""));
      const args: RentArgs = {
        name: nameFor(req.purpose, taken),
        budget: suggestedBudget(best.dph_total, req.hours),
        offers: offers.map((offer) => offer.ask_contract_id),
        image: DIALOG_IMAGE,
        disk_gb: disk,
        purpose: req.purpose,
        need: req.need,
        need_note: note,
      };
      const outcome = await rentOnCard(deps, args, req.sessionId, ui);
      if (outcome.kind === "rented") return { ok: true, key: String(outcome.id) };
      return { ok: false, reason: "Not rented" };
    } catch (caught) {
      return { ok: false, reason: caught instanceof Error ? caught.message : String(caught) };
    }
  };
}
