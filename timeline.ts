/**
 * The spend panel's timeline: the history (`events.ts`) folded into one bar
 * per box — when it started, each extension of its lease, when its lease
 * ends, and when and why it ended — with the boxes listed now still running.
 */

import type { BoxEvent } from "./events";
import { type Lease, leaseOf } from "./leases";
import { costAt } from "./spend";
import type { Instance } from "./vast-api";

export type Extension = {
  at: number;
  /** The lease's end after it. */
  until: number;
  /** Hours added, when the end before it is known. */
  hours: number | null;
};

export type TimelineBox = {
  box: number;
  label: string;
  /** Epoch ms; from the first event when the box's own start was never seen. */
  start: number;
  /** Null while it runs. */
  end: number | null;
  /** The lease's end as last known, or null. */
  until: number | null;
  /** The lease's end before the first extension, or null. */
  firstUntil: number | null;
  budget: number | null;
  /** Dollars an hour. */
  rate: number | null;
  extensions: Extension[];
  /** Why it ended: "cancelled", "budget reached", "gone from the list", … */
  reason: string | null;
  /** Who ended it: "extension", "session", "reader" or null when not known. */
  by: string | null;
  /** What it cost while it ran, from its rate, or null. */
  cost: number | null;
};

type Draft = Omit<TimelineBox, "start"> & { start: number | null; firstAt: number };

const H = 3_600_000;

function draftOf(box: number, at: number): Draft {
  return {
    box,
    label: "",
    start: null,
    end: null,
    until: null,
    firstUntil: null,
    budget: null,
    rate: null,
    extensions: [],
    reason: null,
    by: null,
    cost: null,
    firstAt: at,
  };
}

function extended(d: Draft, event: BoxEvent): void {
  if (event.until === undefined) return;
  const before = d.until;
  d.extensions.push({
    at: event.at,
    until: event.until,
    hours: before === null ? null : (event.until - Math.max(before, event.at)) / H,
  });
  d.until = event.until;
}

/** A broken box keeps "broken" as its reason; one the session cancelled was ended by it. */
function destroyed(d: Draft, event: BoxEvent): void {
  d.end ??= event.at;
  if (d.reason === null || !d.reason.startsWith("broken")) d.reason = event.reason ?? "destroyed";
  d.by = event.by ?? (d.by === "session" ? "session" : "extension");
}

/** A box listed now runs: its start, rate and lease are the list's and the lease file's. */
function listedNow(d: Draft, box: Instance, leases: readonly Lease[], now: number): void {
  d.end = null;
  d.reason = null;
  d.by = null;
  d.label = box.label ?? d.label;
  if (box.start_date !== undefined) d.start = box.start_date * 1000;
  if (box.dph_total !== undefined) d.rate = box.dph_total;
  const lease = leaseOf(leases, box.id ?? -1, box.label ?? "");
  if (lease !== null) {
    d.until = lease.until;
    d.budget = lease.budget;
  }
  d.cost = costAt(box, now);
}

function apply(d: Draft, event: BoxEvent): void {
  if (event.label) d.label = event.label;
  if (event.rate !== undefined) d.rate = event.rate;
  if (event.budget !== undefined) d.budget = event.budget;
  switch (event.kind) {
    case "appeared":
      d.start ??= event.start ?? event.at;
      break;
    case "rented":
      d.start ??= event.at;
      if (event.until !== undefined) {
        d.until = event.until;
        d.firstUntil = event.until;
      }
      break;
    case "extended":
      extended(d, event);
      break;
    case "cancelled":
      d.reason ??= "cancelled";
      d.by ??= "session";
      break;
    case "broken":
      d.reason = `broken: ${event.reason ?? "?"}`;
      break;
    case "destroyed":
      destroyed(d, event);
      break;
    case "gone":
      d.end ??= event.at;
      d.reason ??= "gone from the list";
      break;
  }
}

/**
 * Every box with a bar between `from` and `now`: the events folded per box,
 * the boxes listed now running (their lease end from `leases`).
 */
export function timelineOf(
  events: readonly BoxEvent[],
  listed: readonly Instance[],
  leases: readonly Lease[],
  from: number,
  now: number,
): TimelineBox[] {
  const drafts = new Map<number, Draft>();
  for (const event of events) {
    const d = drafts.get(event.box) ?? draftOf(event.box, event.at);
    drafts.set(event.box, d);
    apply(d, event);
  }
  for (const box of listed) {
    if (box.id === undefined) continue;
    const d = drafts.get(box.id) ?? draftOf(box.id, now);
    drafts.set(box.id, d);
    listedNow(d, box, leases, now);
  }
  const boxes: TimelineBox[] = [];
  for (const { firstAt, ...d } of drafts.values()) {
    const start = d.start ?? firstAt;
    const end = d.end;
    if ((end ?? now) < from) continue;
    const cost = d.cost ?? (end !== null && d.rate !== null ? (d.rate * (end - start)) / H : null);
    boxes.push({ ...d, start, cost });
  }
  return boxes.sort((a, b) => a.start - b.start);
}
