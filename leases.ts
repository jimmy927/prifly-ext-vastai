/**
 * Leases: how long a session has booked a box for.
 *
 * A session books a lease with `vastlease book <name> <hours>` before it rents
 * the box, extends it, and cancels it when it is done. They are kept in
 * `leases.json` in the extension's folder, which both `vastlease` (in a
 * session) and the extension (in the prifly host) read and write, so every
 * change takes the lock and writes the file whole with a rename.
 *
 * A lease is booked for a label — `<owner>/s-<session8>/<name>`, or the older
 * `s-<session8>/<name>` — since the box does not exist yet when it is
 * booked; the extension binds it to the first box with that label that it sees, and from then on it is that box's alone: a
 * later box under the same label does not inherit it.
 */

import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const LeaseSchema = z.object({
  /** `<owner>/s-<session8>/<name>` (or the older `s-<session8>/<name>`), as the box is (or will be) labelled. */
  label: z.string(),
  /** The Vast.ai instance id, once the extension has seen the box; null before. */
  box: z.number().nullable(),
  /** Epoch ms. */
  bookedAt: z.number(),
  /** When the lease ends, epoch ms. */
  until: z.number(),
  /** The session asked for it to end now: save and destroy at once. */
  cancelled: z.boolean(),
});
export type Lease = z.infer<typeof LeaseSchema>;

const FileSchema = z.object({ leases: z.array(LeaseSchema) });

/** No lease reaches further ahead than this: a session books its work, not a month. */
export const MAX_AHEAD_MS = 24 * 3_600_000;
/** How long `book` waits for its box before the lease is dropped as never used. */
export const UNUSED_BOOKING_MS = 3_600_000;

const LOCK_WAIT_MS = 10_000;
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 30_000;

export function leasesPath(folder: string): string {
  return join(folder, "leases.json");
}

export async function readLeases(path: string): Promise<Lease[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return FileSchema.parse(await file.json()).leases;
}

/**
 * Read, change and write the leases under the lock. `change` returns the new
 * list and what to hand back to the caller.
 */
export async function updateLeases<T>(
  path: string,
  change: (leases: Lease[]) => { leases: Lease[]; result: T },
): Promise<T> {
  const release = await lock(`${path}.lock`);
  try {
    const { leases, result } = change(await readLeases(path));
    const temp = `${path}.${process.pid}.tmp`;
    await Bun.write(temp, `${JSON.stringify({ leases }, null, 2)}\n`);
    await rename(temp, path);
    return result;
  } finally {
    await release();
  }
}

async function lock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      return () => rm(path, { force: true });
    } catch (caught) {
      if (!(caught instanceof Error && "code" in caught && caught.code === "EEXIST")) throw caught;
    }
    const held = await stat(path).catch(() => null);
    if (held !== null && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`The lease file is locked: ${path}`);
    await Bun.sleep(50);
  }
}

/** The lease a box holds: the one bound to it, else an unbound one booked for its label. */
export function leaseOf(leases: readonly Lease[], box: number, label: string): Lease | null {
  return (
    leases.find((lease) => lease.box === box) ??
    leases.find((lease) => lease.box === null && lease.label === label) ??
    null
  );
}

/** Which lease a command means: a box's id, or a label (a bound one first, the newest). */
export type LeaseTarget = { box: number } | { label: string };

export function find(leases: readonly Lease[], target: LeaseTarget): Lease | null {
  if ("box" in target) return leases.find((lease) => lease.box === target.box) ?? null;
  const same = leases.filter((lease) => lease.label === target.label);
  return (
    same.filter((lease) => lease.box !== null).at(-1) ??
    same.filter((lease) => lease.box === null).at(-1) ??
    null
  );
}

function hoursOf(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`Not a number of hours: ${hours}`);
  return hours * 3_600_000;
}

function capped(until: number, now: number): number {
  if (until - now > MAX_AHEAD_MS) {
    throw new Error(
      `A lease reaches at most ${MAX_AHEAD_MS / 3_600_000} hours ahead; extend it later.`,
    );
  }
  return until;
}

/**
 * Book `hours` for a box not rented yet, by the label it will carry. Booking
 * a label again replaces its unused booking.
 */
export function book(
  leases: readonly Lease[],
  label: string,
  hours: number,
  now: number,
): { leases: Lease[]; result: Lease } {
  const lease: Lease = {
    label,
    box: null,
    bookedAt: now,
    until: capped(now + hoursOf(hours), now),
    cancelled: false,
  };
  const others = leases.filter((l) => !(l.box === null && l.label === label));
  return { leases: [...others, lease], result: lease };
}

/**
 * Add `hours` to a lease, counted from now if it is already over. `adopt`
 * gives a box that has no lease one from now — the reader keeping a box from
 * its chip's menu.
 */
export function extend(
  leases: readonly Lease[],
  target: LeaseTarget,
  hours: number,
  now: number,
  adopt?: { box: number; label: string },
): { leases: Lease[]; result: Lease } {
  const found = find(leases, target);
  if (found === null && adopt === undefined) throw new Error("No lease for that box");
  const from = found === null ? now : Math.max(found.until, now);
  const lease: Lease = {
    ...(found ?? { ...(adopt ?? { box: null, label: "" }), bookedAt: now }),
    until: capped(from + hoursOf(hours), now),
    cancelled: false,
  };
  return { leases: [...leases.filter((l) => l !== found), lease], result: lease };
}

/** End a lease now: the extension saves the box and destroys it; an unused booking is dropped. */
export function cancel(
  leases: readonly Lease[],
  target: LeaseTarget,
): { leases: Lease[]; result: Lease } {
  const found = find(leases, target);
  if (found === null) throw new Error("No lease for that box");
  const rest = leases.filter((l) => l !== found);
  const lease = { ...found, cancelled: true };
  return { leases: found.box === null ? rest : [...rest, lease], result: lease };
}

/**
 * Bind each unbound lease to the box that now carries its label, and drop
 * leases whose box is gone or whose booking was never used. Pure, for
 * `updateLeases`; `changed` says whether there is anything to write.
 */
export function tidy(
  leases: readonly Lease[],
  boxes: readonly { id: number; label: string }[],
  now: number,
): { leases: Lease[]; changed: boolean } {
  const live = new Set(boxes.map((box) => box.id));
  const bound = new Set(leases.flatMap((lease) => (lease.box === null ? [] : [lease.box])));
  let changed = false;
  const next: Lease[] = [];
  for (const lease of leases) {
    if (lease.box !== null) {
      if (live.has(lease.box)) next.push(lease);
      else changed = true;
      continue;
    }
    const box = boxes.find((b) => b.label === lease.label && !bound.has(b.id));
    if (box !== undefined) {
      bound.add(box.id);
      next.push({ ...lease, box: box.id });
      changed = true;
    } else if (now - lease.bookedAt > UNUSED_BOOKING_MS || lease.cancelled) {
      changed = true;
    } else {
      next.push(lease);
    }
  }
  return { leases: next, changed };
}
