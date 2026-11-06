/**
 * `vast_cancel`: ends a lease and destroys its box, whatever `enforce` says —
 * a cancel is the reader's order. The destroy is the enforcer's own take-down
 * (`Enforcer.cancelNow`: save hook, destroy, then Vast.ai's instance list read
 * until the box is gone), so the answer never claims a destroy it did not see.
 */

import { z } from "zod";
import { destroyNote } from "./campaign";
import { cancel, find, type Lease, readLeases, updateLeases } from "./leases";
import type { ExtensionTool } from "./prifly-api";
import { boxLabels, defineTool, NAME, type ToolDeps } from "./tool-kit";
import { listInstances } from "./vast-api";

/** How long `vast_cancel` waits for a box to be saved and destroyed before it says the take-down is still going. */
const CANCEL_WAIT_MS = 4 * 60_000;

export function cancelTool(deps: ToolDeps): ExtensionTool {
  return defineTool(
    "vast_cancel",
    "End one of this session's boxes' leases now: the box is saved (/root/.lease/save, if it has one), destroyed, and the answer comes once Vast.ai's box list no longer has it (\"Destroyed ...; it no longer bills\"). Whatever the lease enforcement setting, this destroys the box. If the save takes long the answer says the box is not destroyed yet and vast_boxes shows when it is gone; a failed destroy is an error that says the box is still running and billing. A booking nothing was rented for is just dropped.",
    z.strictObject({ name: z.string().describe("The box's name (or its Vast.ai id)") }),
    async (args, ctx) => {
      const owner = await deps.owner();
      const leases = await readLeases(deps.store);
      const label = leaseLabel(leases, owner, ctx.session, args.name);
      const lease = await updateLeases(deps.store, (current) => cancel(current, { label }));
      if (lease.box !== null) deps.log("cancelled", { instance: lease.box, label });
      deps.refresh();
      return lease.box === null
        ? `Dropped the booking for ${args.name}.`
        : await destroyNow(deps, args.name, lease.box);
    },
  );
}

/**
 * Save and destroy a cancelled lease's box and say what happened, after
 * reading Vast.ai's box list: "Destroyed" only once the box is not on it. A
 * failure throws, saying the box is still running and billing.
 */
async function destroyNow(deps: ToolDeps, name: string, id: number): Promise<string> {
  const listed = await listInstances(await deps.keys(), deps.get).catch((caught: unknown) => {
    const why = caught instanceof Error ? caught.message : String(caught);
    throw new Error(
      `${name} (#${id}) is cancelled, but Vast.ai's box list could not be read (${why}), so nothing was destroyed: it may still be running and billing. vast_cancel ${name} tries again.`,
    );
  });
  const box = listed.find((b) => b.id === id);
  if (box === undefined) return `${name} (#${id}) is no longer on Vast.ai; nothing bills for it.`;
  const ended = await within(deps.takeDown(box), deps.cancelWaitMs ?? CANCEL_WAIT_MS);
  if (ended === null) {
    return `Cancelled ${name} (#${id}): it is being saved before it is destroyed, which can take up to 10 minutes. It is not destroyed yet and still bills; vast_boxes shows when it is gone.`;
  }
  if (ended.kind === "failed") {
    throw new Error(
      `${name} (#${id}) is still running and billing: ${ended.why}. Its lease is cancelled; vast_cancel ${name} tries again.`,
    );
  }
  if (ended.kind === "kept") {
    throw new Error(
      `${name} (#${id}) was not destroyed: its lease was extended meanwhile or the extension was stopping. It is still running and billing.`,
    );
  }
  return `Destroyed ${name} (#${id}); it no longer bills.${destroyNote(ended.hook, ended.pulled)}`;
}

/** What `work` answers, or null when it has not answered after `ms` (it goes on). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The label of this session's lease for a name (a Vast.ai id is looked up among the leases). */
function leaseLabel(
  leases: readonly Lease[],
  owner: string,
  session: string,
  which: string,
): string {
  const byId = /^\d+$/.test(which) ? leases.find((l) => l.box === Number(which)) : undefined;
  if (byId !== undefined) {
    const mine = boxLabels(owner, session, "").some((label) => byId.label.startsWith(label));
    if (!mine) throw new Error(`Box ${which} is not this session's`);
    return byId.label;
  }
  if (!NAME.test(which)) throw new Error(`Not a box name: ${which}`);
  const label = boxLabels(owner, session, which).find((l) => find(leases, { label: l }) !== null);
  if (label === undefined)
    throw new Error(`This session has no lease for ${which}: vast_boxes lists its boxes`);
  return label;
}
