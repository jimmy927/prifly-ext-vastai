/**
 * What a box's machine card and chip say about its lease: the status line and
 * the action menu, from the same `Judged` verdict, so both agree.
 */

import type { Judged } from "./enforce";
import type { Lease } from "./leases";
import type { DecorationAction, DecorationTone, ExtensionMachine } from "./prifly-api";
import { IDLE_MS, parseLabel, span } from "./rules";

/** The chip menu's "Extend lease" choices, in hours. */
export const EXTEND_HOURS: Record<string, number> = { extend1: 1, extend4: 4 };

/** Whether the lease rules act on a box: this owner's, from a session this prifly knows. */
export function isManaged(lease: Judged | undefined): boolean {
  const kind = lease?.verdict.kind;
  return kind !== undefined && kind !== "unmanaged" && kind !== "foreign" && kind !== "stranger";
}

/** The menu of a box, chip or card: Extend is there always, disabled where it does not apply. */
export function boxActions(
  id: number | string,
  name: string,
  rate: string,
  lease: Judged | undefined,
  disableAll = false,
): DecorationAction[] {
  const disabled = disableAll || !isManaged(lease);
  return [
    { id: "extend1", label: "Extend lease by 1 hour", disabled },
    { id: "extend4", label: "Extend lease by 4 hours", disabled },
    {
      id: "destroy",
      label: "Destroy box…",
      confirm: `Destroy ${name} (Vast.ai #${id}, ${rate})? The box and everything on its disk are deleted, and it stops billing. This cannot be undone.`,
      destructive: true,
      disabled: disableAll,
    },
  ];
}

function clock(epoch: number): string {
  const at = new Date(epoch);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** "1h 05m": a quiet spell, minutes always two digits. */
function idleSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The status line of a box's machine card. */
export function statusOf(
  lease: Judged | undefined,
  session: string | null,
  owner: string,
  enforce: boolean,
): { text: string; tone?: DecorationTone } {
  const verdict = lease?.verdict;
  if (lease === undefined || verdict === undefined || verdict.kind === "unmanaged") {
    return { text: "Not managed by leases: rented by another program", tone: "muted" };
  }
  if (verdict.kind === "foreign") {
    return { text: `${verdict.owner} · not managed by this prifly`, tone: "muted" };
  }
  if (verdict.kind === "stranger") {
    return { text: `session ${verdict.session} is not this prifly's`, tone: "warning" };
  }
  const head = `${owner} · session ${session ?? "?"}`;
  const ends = lease.until === null ? "" : clock(lease.until);
  const idle = lease.idleMs >= IDLE_MS ? ` · idle ${idleSpan(lease.idleMs)}` : "";
  switch (verdict.kind) {
    case "leased":
      return { text: `${head} · leased until ${ends} · ${span(verdict.leftMs)} left${idle}` };
    case "ending":
      return {
        text: `${head} · leased until ${ends} · ${span(verdict.leftMs)} left${idle}`,
        tone: "warning",
      };
    case "grace":
      return {
        text: `${head} · lease ended ${ends} · destroyed in ${span(verdict.leftMs)} unless extended`,
        tone: "critical",
      };
    case "unbooked":
      return {
        text: `${head} · no lease · destroyed in ${span(verdict.leftMs)} unless booked`,
        tone: "critical",
      };
    default:
      return {
        text: `${head} · ${enforce ? "being destroyed" : "would be destroyed"}: ${verdict.reason}`,
        tone: "critical",
      };
  }
}

/** Bookings not yet bound to a box, on the provider's card; its menu is there but off. */
export function providerCard(
  waiting: readonly Lease[],
): Pick<ExtensionMachine, "status" | "actions"> {
  const text =
    waiting.length === 0
      ? "No bookings waiting"
      : `${waiting.length} booking${waiting.length === 1 ? "" : "s"} waiting: ${waiting
          .map((l) => `${parseLabel(l.label)?.name ?? l.label}, ${hours(l.until - l.bookedAt)} h`)
          .join(", ")}`;
  return { status: { text }, actions: boxActions("?", "a box", "", undefined, true) };
}

function hours(ms: number): string {
  return String(Math.round(ms / 360_000) / 10);
}

/**
 * A session's box's lease, for its chip: a few words, a colour when the lease
 * asks for attention (null leaves the load's colour), and hover lines.
 */
export function leaseLine(
  { verdict, idleMs, until }: Judged,
  enforce: boolean,
): { short: string; tone: DecorationTone | null; details: string[] } | null {
  const ends = until === null ? "" : new Date(until).toLocaleTimeString([], { timeStyle: "short" });
  const idle = idleMs >= 60 * 60_000 ? [`Idle for ${span(idleMs)} (CPU, GPU and network)`] : [];
  const off = enforce ? [] : ["Lease enforcement is off: nothing is destroyed."];
  switch (verdict.kind) {
    case "unmanaged":
      return null;
    case "foreign":
      return {
        short: "other prifly",
        tone: null,
        details: [`Another prifly's box (owner ${verdict.owner}): never enforced here`],
      };
    case "stranger":
      return {
        short: "not ours",
        tone: "warning",
        details: [
          `Session ${verdict.session} is not this prifly's session: never destroyed or guarded here`,
        ],
      };
    case "leased":
      return {
        short: span(verdict.leftMs),
        tone: null,
        details: [`Leased until ${ends} (${span(verdict.leftMs)} left)`, ...idle],
      };
    case "ending":
      return {
        short: `${span(verdict.leftMs)} left`,
        tone: "warning",
        details: [`Lease ends ${ends}: extend it or the box is destroyed`, ...idle],
      };
    case "grace":
      return {
        short: "lease over",
        tone: "critical",
        details: [
          `Lease ended ${ends}: destroyed in ${span(verdict.leftMs)} unless extended`,
          ...off,
        ],
      };
    case "unbooked":
      return {
        short: "no lease",
        tone: "critical",
        details: [`No lease: destroyed in ${span(verdict.leftMs)} unless booked`, ...off],
      };
    case "due":
      return {
        short: enforce ? "destroying" : "no lease",
        tone: "critical",
        details: [
          `${enforce ? "Being saved and destroyed" : "Would be destroyed"}: ${verdict.reason}`,
          ...off,
        ],
      };
    default:
      return null;
  }
}
