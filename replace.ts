/**
 * Renting a broken box's replacement, from the card the reader already
 * confirmed: the next offer on it that is still there, is not on a machine
 * that gave a broken box, and fits what is left of the confirmed budget.
 * `enforce.ts` calls it once it has cancelled the broken box; no new card is
 * shown, because the reader's word was for this budget, not for this box.
 */

import { book, dropBooking, type Replace, updateLeases } from "./leases";
import { fetchOffer, type Offer } from "./offers";
import { refusalOf, runHours } from "./rent";
import { budgetText } from "./spend";
import { sshText, type ToolDeps } from "./tool-kit";
import { createInstance, listInstances, OfferGone, withKeys } from "./vast-api";

/** A rent replaces its boxes at most this many times. */
export const MAX_REPLACEMENTS = 3;

export type ReplaceDeps = Pick<ToolDeps, "store" | "keys" | "get" | "now" | "log" | "sshKey">;

export type Rented =
  | { kind: "rented"; box: number; offer: Offer; budget: number; ssh: string | null }
  | { kind: "none"; why: string };

/**
 * Rent the first of `state.offers` that fits. `state` is the new box's: its
 * count, excluded machines and spent dollars already say what the broken one
 * cost. The booking carries it on, with the budget that is left.
 */
export async function rentNext(deps: ReplaceDeps, label: string, state: Replace): Promise<Rented> {
  const rest = state.confirmed - state.spent;
  if (rest <= 0) {
    return {
      kind: "none",
      why: `the boxes of this rent have already cost the whole ${budgetText(state.confirmed)}`,
    };
  }
  const notes: string[] = [];
  let created = false;
  try {
    for (const [index, id] of state.offers.entries()) {
      const box = await tryNext(deps, { label, state, rest, index, id }, notes);
      if (box !== null) {
        created = true;
        return box;
      }
    }
  } finally {
    if (!created) await updateLeases(deps.store, (leases) => dropBooking(leases, label));
  }
  return {
    kind: "none",
    why: `no offer on the card fits the ${budgetText(Number(rest.toFixed(2)))} that is left of ${budgetText(state.confirmed)} (${notes.join("; ") || "the card has no offers left"})`,
  };
}

type Next = { label: string; state: Replace; rest: number; index: number; id: number };

/** Look at one offer again, book the lease and create the box; null with the reason noted when it cannot be. */
async function tryNext(
  deps: ReplaceDeps,
  { label, state, rest, index, id }: Next,
  notes: string[],
): Promise<Rented | null> {
  const offer = await fetchOffer(id, state.request.disk, deps.get);
  if (offer === null) {
    notes.push(`offer ${id} is gone`);
    return null;
  }
  if (offer.machine_id !== undefined && state.excluded.includes(offer.machine_id)) {
    notes.push(`offer ${id} is on machine ${offer.machine_id}, which gave a broken box`);
    return null;
  }
  const now = deps.now();
  const hours = runHours(offer, rest);
  const refusal = refusalOf(offer, rest, hours, now);
  if (refusal !== null) {
    notes.push(refusal);
    return null;
  }
  const next: Replace = {
    ...state,
    offers: state.offers.slice(index + 1),
    machine: offer.machine_id ?? null,
  };
  await updateLeases(deps.store, (leases) => book(leases, label, hours, now, rest, next));
  const box = await create(deps, { id, label, state }, notes);
  if (box === null) return null;
  deps.log("replacement_rented", {
    offer: id,
    instance: box,
    label,
    budget: rest,
    until: now + hours * 3_600_000,
    rate: offer.dph_total,
  });
  const listed = (await listInstances(await deps.keys(), deps.get)).find((b) => b.id === box);
  const ssh = listed === undefined ? null : sshText(listed, deps.sshKey);
  return { kind: "rented", box, offer, budget: Number(rest.toFixed(2)), ssh };
}

/** Create the box; its id, or null with the reason noted. After an unclear failure, look for a box that was made. */
async function create(
  deps: ReplaceDeps,
  { id, label, state }: { id: number; label: string; state: Replace },
  notes: string[],
): Promise<number | null> {
  try {
    return await withKeys(await deps.keys(), (key) =>
      createInstance(key, id, state.request, deps.get),
    );
  } catch (caught) {
    if (caught instanceof OfferGone) {
      notes.push(caught.message);
      return null;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    const old = state.replaces?.box;
    const existing = (await listInstances(await deps.keys(), deps.get)).find(
      (b) => b.label === label && b.id !== undefined && b.id !== old,
    );
    if (existing?.id !== undefined) return existing.id;
    notes.push(message);
    return null;
  }
}
