/**
 * The lease rules, as pure functions of what the extension has seen.
 *
 * Only a box a session rented is ever judged: one labelled
 * `s-<session8>/<name>`. Boxes rented by hand or by other software carry
 * other labels (or none), have their own clean-up, and are left alone.
 *
 * A session's box must hold a lease. With none it is destroyed — booking comes
 * before renting, so the only grace is `BOOKING_MS` for a session that rents
 * first and books right after. A lease that runs out gets `GRACE_MS` to be
 * extended, and then the box is saved and destroyed. Idleness inside a lease
 * is only ever warned about: the lease is what the session asked for.
 */

import type { Lease } from "./leases";

export const SESSION_LABEL = /^s-([0-9a-f]{8})\/(.+)$/;

/** The warning before a lease ends. */
export const ENDING_MS = 15 * 60_000;
/** After a lease ends, the time left to extend it. */
export const GRACE_MS = 15 * 60_000;
/** A new box with no lease yet: the time its session has to book one. */
export const BOOKING_MS = 5 * 60_000;
/** Below this CPU and GPU, a box is not computing. */
export const IDLE_PCT = 5;
/** Traffic that makes a box busy: a download or an upload, in Vast.ai's billed KiB. */
export const IDLE_NET_KIB = 10 * 1024;
/** Quiet for this long in a row, a box is idle. */
export const IDLE_MS = 60 * 60_000;

export type Verdict =
  | { kind: "unmanaged" }
  | { kind: "unbooked"; leftMs: number }
  | { kind: "leased"; leftMs: number }
  | { kind: "ending"; leftMs: number }
  | { kind: "grace"; leftMs: number }
  | { kind: "due"; reason: "no lease" | "lease over" | "cancelled" };

/** What the rules need to know of a box. */
export type BoxFacts = { id: number; label: string; startedAt: number | null };

export function isSessionBox(label: string): boolean {
  return SESSION_LABEL.test(label);
}

export function judge(box: BoxFacts, lease: Lease | null, now: number): Verdict {
  if (!isSessionBox(box.label)) return { kind: "unmanaged" };
  if (lease === null) {
    const booking = (box.startedAt ?? now) + BOOKING_MS - now;
    return booking > 0
      ? { kind: "unbooked", leftMs: booking }
      : { kind: "due", reason: "no lease" };
  }
  if (lease.cancelled) return { kind: "due", reason: "cancelled" };
  const left = lease.until - now;
  if (left > ENDING_MS) return { kind: "leased", leftMs: left };
  if (left > 0) return { kind: "ending", leftMs: left };
  const grace = left + GRACE_MS;
  return grace > 0 ? { kind: "grace", leftMs: grace } : { kind: "due", reason: "lease over" };
}

/** One reading of a box's load: CPU and GPU in %, traffic as Vast.ai's running billed total. */
export type Load = { cpu: number | null; gpu: number | null; netKiB: number | null };

/**
 * How long each box has been quiet: CPU and GPU below `IDLE_PCT`, and no more
 * than `IDLE_NET_KIB` of traffic since the quiet began. Low CPU alone is not
 * idle — a box downloading a dataset or waiting on its disk shows 0 % too, and
 * the traffic is what tells them apart. Kept in memory: after a restart the
 * extension watches for `IDLE_MS` again before calling a box idle.
 */
export class IdleWatch {
  readonly #quiet = new Map<number, { since: number; netAt: number }>();

  /** Record a reading; how long the box has now been quiet, in ms. */
  observe(box: number, load: Load, now: number): number {
    const net = load.netKiB ?? 0;
    const quiet = (load.cpu ?? 0) < IDLE_PCT && (load.gpu ?? 0) < IDLE_PCT;
    const known = this.#quiet.get(box);
    if (!quiet || known === undefined || net - known.netAt > IDLE_NET_KIB) {
      this.#quiet.set(box, { since: now, netAt: net });
      return 0;
    }
    return now - known.since;
  }

  /** Forget the boxes that are gone. */
  keep(boxes: ReadonlySet<number>): void {
    for (const box of this.#quiet.keys()) if (!boxes.has(box)) this.#quiet.delete(box);
  }
}

/** "1h 40m", "12m", "45s": a lease's time, for a chip or a notice. */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes === 0) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
}
