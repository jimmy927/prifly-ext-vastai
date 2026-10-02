/**
 * What a box has cost, from the boxes Vast.ai lists every minute: nothing is
 * stored, so a restart loses nothing and the number cannot drift.
 *
 * `dph_total` is the rate Vast.ai bills per hour, disk included, and
 * `start_date` is when the box last started, so the product is what this run
 * has cost. Bandwidth charged per GB is not in `dph_total` and not counted.
 */

import type { Instance } from "./vast-api";

const HOUR_MS = 3_600_000;
/** The share of a budget at which the reader is told it is nearly spent. */
export const BUDGET_WARN = 0.9;

/** Dollars this box will have cost at `when` (epoch ms); null when Vast.ai did not say when it started or at what rate. */
export function costAt(box: Instance, when: number): number | null {
  const { start_date: start, dph_total: rate } = box;
  if (start === undefined || rate === undefined) return null;
  return rate * (Math.max(0, when - start * 1000) / HOUR_MS);
}

/** Dollars this box has cost since it started; null when Vast.ai did not say when or at what rate. */
export function spentOf(box: Instance, now: number): number | null {
  return costAt(box, now);
}

/** When a box will have cost `budget`, epoch ms; null when its start or rate is unknown or it bills nothing. */
export function budgetEnd(box: Instance, budget: number): number | null {
  const { start_date: start, dph_total: rate } = box;
  if (start === undefined || rate === undefined || rate <= 0) return null;
  return start * 1000 + (budget / rate) * HOUR_MS;
}

/** A lease's end, held to the hour the budget runs out, so the on-box guard enforces the budget too. */
export function cappedUntil(until: number, box: Instance, budget: number | null): number {
  if (budget === null) return until;
  const end = budgetEnd(box, budget);
  return end === null ? until : Math.min(until, Math.floor(end));
}

/** "$7.40": dollars to the cent. */
export function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** "$20", or "$12.50": a budget has no cents when it is a whole number of dollars. */
export function budgetText(budget: number): string {
  return Number.isInteger(budget) ? `$${budget}` : dollars(budget);
}

/** "$7.40 of $20": what a box has cost of its budget. */
export function spentLine(spent: number, budget: number): string {
  return `${dollars(spent)} of ${budgetText(budget)}`;
}
