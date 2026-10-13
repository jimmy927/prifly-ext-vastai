/** Small readings of a box and of times, shared by the enforcer (`enforce.ts`). */

import { readLoad } from "./load";
import { type BoxFacts, hostEnd, type Load, parseLabel, span } from "./rules";
import type { Instance } from "./vast-api";

const HOUR_MS = 3_600_000;

/** What the rules need of a box: its label, start, cost so far and the host's end date. */
export function factsOf(box: Instance, id: number, spent: number | null): BoxFacts {
  return {
    id,
    label: box.label ?? "",
    startedAt: box.start_date === undefined ? null : box.start_date * 1000,
    spent,
    endsAt: hostEnd(box),
  };
}

/** "11h 36m", or "as long as nothing bills". */
export function runwayText(hours: number): string {
  return Number.isFinite(hours) ? span(hours * HOUR_MS) : "as long as nothing bills";
}

/** "07:10": the time of day, as the reader's clock shows it. */
export function clockOf(epoch: number): string {
  return Number.isFinite(epoch)
    ? new Date(epoch).toLocaleTimeString([], { timeStyle: "short" })
    : "never";
}

export function nameOf(box: Instance): string {
  return parseLabel(box.label ?? "")?.name ?? `#${box.id ?? "?"}`;
}

export function loadOf(box: Instance): Load {
  const { coresBusy, gpu } = readLoad(box);
  const up = box.inet_up_billed ?? null;
  const down = box.inet_down_billed ?? null;
  return {
    coresBusy,
    gpu,
    netKiB: up === null && down === null ? null : (up ?? 0) + (down ?? 0),
  };
}
