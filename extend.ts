/**
 * How far a lease can be extended: the one calculation `vast_extend`
 * (`tools.ts`) and the campaign hold (`enforce.ts`) share, so both stop at the
 * same limits: the hours asked for, the budget, and the host's end date. The
 * 24 hour maximum is `MAX_AHEAD_MS` in `leases.ts`, checked by `extend`.
 */

import type { Lease } from "./leases";
import { EXPIRY_MARGIN_MS, hostEnd } from "./rules";
import { budgetEnd } from "./spend";
import type { Instance } from "./vast-api";

const HOUR_MS = 3_600_000;

/** The latest a lease may end for this box: `EXPIRY_MARGIN_MS` before the host's end date; null when it has none. */
export function hostCapOf(box: Instance): number | null {
  const end = hostEnd(box);
  return end === null ? null : end - EXPIRY_MARGIN_MS;
}

export type Reach = {
  /** Where the added time starts: the lease's end, or now when it is over. */
  from: number;
  /** Where the lease would end: `hours` later, held to the budget's hour and the host's cap. */
  end: number;
  /** Hours that fit, 0 when none do. */
  allowed: number;
  hostCap: number | null;
};

/** What adding `hours` to a lease reaches under `budget` (dollars, or null for none) at `now`. */
export function reachOf(
  box: Instance,
  lease: Pick<Lease, "until">,
  hours: number,
  budget: number | null,
  now: number,
): Reach {
  const from = Math.max(lease.until, now);
  const limit = budget === null ? null : budgetEnd(box, budget);
  const hostCap = hostCapOf(box);
  const end = Math.min(
    from + hours * HOUR_MS,
    limit ?? Number.POSITIVE_INFINITY,
    hostCap ?? Number.POSITIVE_INFINITY,
  );
  return { from, end, allowed: Math.max(0, (end - from) / HOUR_MS), hostCap };
}
