/**
 * What the enforcer tells the reader as a box's lease runs out or its budget
 * is nearly spent. With lease enforcement off (`"enforce": false`) nothing is
 * destroyed, so none of these may say a box will be: they say it keeps billing.
 */

import type { DecorationTone } from "./prifly-api";
import { GRACE_MS, span, type Verdict } from "./rules";
import { budgetText, spentLine } from "./spend";

export type LeaseNotice = { key: string; text: string; tone: DecorationTone };

/** The warning for a lease about to end, in its grace, or a box with none; null for any other verdict. */
export function leaseNotice(
  verdict: Verdict,
  name: string,
  until: number | null,
  enforce: boolean,
): LeaseNotice | null {
  const off = "Lease enforcement is off, so nothing is destroyed";
  switch (verdict.kind) {
    case "unbooked":
      return {
        key: "unbooked",
        text: enforce
          ? `${name} has no lease and is destroyed in ${span(verdict.leftMs)}: Extend lease on its menu keeps it.`
          : `${name} has no lease. ${off}: it keeps billing until it is destroyed by hand.`,
        tone: "critical",
      };
    case "ending":
      return {
        key: `ending:${until}`,
        text: `${name}'s lease ends in ${span(verdict.leftMs)}: vast_extend adds time${enforce ? `, or it is destroyed ${span(GRACE_MS)} after` : `. ${off}: vast_cancel ends it`}.`,
        tone: "warning",
      };
    case "grace":
      return {
        key: `grace:${until}`,
        text: enforce
          ? `${name}'s lease is over: it is saved and destroyed in ${span(verdict.leftMs)} unless extended.`
          : `${name}'s lease is over. ${off}: it keeps billing until vast_cancel ends it.`,
        tone: "critical",
      };
    default:
      return null;
  }
}

/** The warning that a box has cost most of its budget. */
export function budgetNotice(name: string, spent: number, budget: number, enforce: boolean) {
  return enforce
    ? `${name} has cost ${spentLine(spent, budget)}: at ${budgetText(budget)} it is saved and destroyed. vast_extend asks the reader to raise the budget.`
    : `${name} has cost ${spentLine(spent, budget)}. Lease enforcement is off, so nothing is destroyed at ${budgetText(budget)}: vast_cancel ends the box.`;
}
