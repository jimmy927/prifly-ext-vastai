/**
 * The lease rules, as pure functions of what the extension has seen.
 *
 * Only a box a session of this prifly rented is ever judged: one labelled
 * `<owner>/s-<session8>/<name>` with this prifly's owner, or the older
 * `s-<session8>/<name>`, still taken as this owner's during the change-over.
 * Boxes rented by hand or by other software carry other labels (or none),
 * have their own clean-up, and are left alone. A box of another owner — a
 * prifly on another machine using the same Vast.ai account — is shown, never
 * judged. And one whose session this prifly does not know is only warned
 * about: whatever its label says, it is not this prifly's to destroy.
 *
 * A session's box must hold a lease. With none it is destroyed — booking comes
 * before renting, so the only grace is `BOOKING_MS` for a session that rents
 * first and books right after. A lease that runs out gets `GRACE_MS` to be
 * extended, and then the box is saved and destroyed. Idleness inside a lease
 * is only ever warned about: the lease is what the session asked for.
 *
 * A lease may carry a dollar budget, the amount the reader confirmed. A box
 * that has cost that much is due at once, whatever its lease says.
 */

import type { Lease } from "./leases";

/** `<owner>/s-<session8>/<name>`, the owner left out on the older labels. */
export const SESSION_LABEL = /^(?:([a-z0-9_-]{1,16})\/)?s-([0-9a-f]{8})\/(.+)$/;
/** The longest owner a label carries. */
const OWNER_MAX = 16;

export type SessionLabel = { owner: string | null; session: string; name: string };

/** The owner, session and name a label carries; null for any other label. */
export function parseLabel(label: string): SessionLabel | null {
  const match = SESSION_LABEL.exec(label);
  if (match === null) return null;
  return { owner: match[1] ?? null, session: match[2] ?? "", name: match[3] ?? "" };
}

/** A label's owner part from a config value or a user name: lower-case, `[a-z0-9_-]`, at most 16. */
export function ownerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, OWNER_MAX);
}

/** The label a session's box is rented with. */
export function sessionLabel(owner: string, session: string, name: string): string {
  return `${owner}/s-${session.slice(0, 8)}/${name}`;
}

/** Who this prifly is, for the rules: its owner, and the ids of every session it knows, past ones too. */
export type Mine = { owner: string; sessions: readonly string[] };

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
  | { kind: "foreign"; owner: string }
  | { kind: "stranger"; session: string }
  | { kind: "unbooked"; leftMs: number }
  | { kind: "leased"; leftMs: number }
  | { kind: "ending"; leftMs: number }
  | { kind: "grace"; leftMs: number }
  | { kind: "due"; reason: "no lease" | "lease over" | "cancelled" | "budget reached" };

/** What the rules need to know of a box; `spent` is what it has cost, in dollars, when known. */
export type BoxFacts = {
  id: number;
  label: string;
  startedAt: number | null;
  spent?: number | null;
};

/** A session's box of this owner: labelled with it, or with the older label that has none. */
export function isOwnBox(label: string, owner: string): boolean {
  const parsed = parseLabel(label);
  return parsed !== null && (parsed.owner === null || parsed.owner === owner);
}

/** Whether a label's session is one this prifly knows: some session id starts with it. */
export function knowsSession(sessions: readonly string[], session8: string): boolean {
  return sessions.some((id) => id.startsWith(session8));
}

/**
 * The verdict on a box. Only a box of this owner, from a session this prifly
 * knows, can come out `due`; another owner's is `foreign` and an unknown
 * session's `stranger`, whatever its lease says.
 */
export function judge(box: BoxFacts, lease: Lease | null, now: number, mine: Mine): Verdict {
  const parsed = parseLabel(box.label);
  if (parsed === null) return { kind: "unmanaged" };
  if (parsed.owner !== null && parsed.owner !== mine.owner) {
    return { kind: "foreign", owner: parsed.owner };
  }
  if (!knowsSession(mine.sessions, parsed.session)) {
    return { kind: "stranger", session: parsed.session };
  }
  return leaseVerdict(box, lease, now);
}

function leaseVerdict(box: BoxFacts, lease: Lease | null, now: number): Verdict {
  if (lease === null) {
    const booking = (box.startedAt ?? now) + BOOKING_MS - now;
    return booking > 0
      ? { kind: "unbooked", leftMs: booking }
      : { kind: "due", reason: "no lease" };
  }
  if (lease.cancelled) return { kind: "due", reason: "cancelled" };
  if (lease.budget !== null && (box.spent ?? 0) >= lease.budget) {
    return { kind: "due", reason: "budget reached" };
  }
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
