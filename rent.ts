/**
 * `vast_rent`: rent a box only after the reader has seen the price and set the
 * budget.
 *
 * The session proposes offers (best first) and a budget. Each offer is fetched
 * again for today's price, and the ones that are gone, or that could not run
 * an hour within the budget, are left off. What is left goes on prifly's pick
 * card with the budget as an editable amount; nothing is booked or created
 * before the reader answers. The lease is booked with the amount the reader
 * CONFIRMED, not the one suggested, and its end is held to the hour that budget
 * runs out (and to 24 hours). If the chosen offer is gone by then, the next
 * card rows that still fit the confirmed budget are tried in card order.
 */

import { z } from "zod";
import { book, dropBooking, leasesPath, MAX_AHEAD_MS, updateLeases } from "./leases";
import { fetchOffer, type Offer } from "./offers";
import type { ExtensionPick, ExtensionTool, ExtensionToolContext } from "./prifly-api";
import { sessionLabel } from "./rules";
import { budgetText, dollars } from "./spend";
import { defineTool, endText, HOUR_MS, NAME, rateCell, sshText, type ToolDeps } from "./tool-kit";
import { createInstance, listInstances, OfferGone, withKeys } from "./vast-api";

const PORT = /^\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/;

const RentArgs = z.strictObject({
  name: z
    .string()
    .regex(NAME)
    .describe(
      "The box's name: at most 8 characters, letters, digits, - and _. It is the box's label's last part.",
    ),
  budget: z
    .number()
    .positive()
    .describe(
      "Your suggested budget in dollars for the whole rental. The reader sees it on the card and may change it; the confirmed amount is the box's hard limit: it is saved and destroyed when it has cost this much.",
    ),
  offers: z
    .array(z.number().int().positive())
    .min(1)
    .max(12)
    .describe(
      "Offer ids (ask_contract_id from vast_offers), best first. If the chosen one is gone, the next that fits the budget is rented.",
    ),
  image: z.string().min(1).describe("Docker image, e.g. ubuntu:22.04"),
  disk_gb: z.number().positive().describe("Disk in GB. It is billed, so it is in the rate."),
  onstart: z
    .string()
    .optional()
    .describe("Shell commands to run on start. Default: sleep infinity, so a bare image stays up."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables, name to value."),
  ports: z
    .array(z.string().regex(PORT))
    .optional()
    .describe('Ports to open, e.g. "8080:8080/tcp".'),
  purpose: z
    .string()
    .min(1)
    .describe(
      "What the box is for and why this budget: it is shown on the card, in the reader's words, as the reason for the suggestion.",
    ),
});
type RentArgs = z.infer<typeof RentArgs>;

const DESCRIPTION =
  "Rent a Vast.ai box. Shows the reader the offers on a card with an editable budget and waits for their answer; only then is a lease booked and the box created. Offers that are gone, or could not run an hour within the budget, are left off. If the chosen offer is gone, the next card row that fits the budget is rented. Returns the box's id, label, rate, budget, lease end and ssh command. Use vast_offers first to find offer ids. Never rent any other way.";

export function rentTool(deps: ToolDeps): ExtensionTool {
  return defineTool("vast_rent", DESCRIPTION, RentArgs, (args, ctx) => rent(deps, args, ctx));
}

/** The hint under the amount field: the session's reason for the suggestion. */
function hintOf(purpose: string): string {
  const reason = purpose
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 240);
  return `Suggested by Claude: ${reason}. The box is saved and destroyed when it has cost this much.`;
}

const COLUMNS = [
  "GPU",
  "VRAM",
  "CPU",
  "RAM",
  "Disk",
  "$/h",
  "Hours",
  "Reliability",
  "Location",
  "Offer",
];

function rowOf(offer: Offer, budget: number): string[] {
  const gpus = (offer.num_gpus ?? 1) > 1 ? `${offer.num_gpus}x ` : "";
  const gb = (mb: number | undefined) => (mb === undefined ? "?" : `${Math.round(mb / 1000)} GB`);
  return [
    `${gpus}${offer.gpu_name ?? "?"}`,
    gb(offer.gpu_ram),
    `${Math.round(offer.cpu_cores_effective ?? 0)} cores`,
    gb(offer.cpu_ram),
    `${Math.round(offer.disk_space ?? 0)} GB`,
    rateCell(offer.dph_total),
    (budget / offer.dph_total).toFixed(1),
    (offer.reliability ?? 0).toFixed(3),
    offer.geolocation ?? "?",
    String(offer.ask_contract_id),
  ];
}

/** Today's offers for the ids, in the session's order, without those gone or too dear for an hour. */
async function cardOffers(deps: ToolDeps, args: RentArgs): Promise<Offer[]> {
  const ids = [...new Set(args.offers)];
  const found = await Promise.all(ids.map((id) => fetchOffer(id, args.disk_gb, deps.get)));
  return found.flatMap((offer) =>
    offer !== null && offer.dph_total <= args.budget ? [offer] : [],
  );
}

function cardOf(args: RentArgs, offers: readonly Offer[]): ExtensionPick {
  return {
    title: `Rent ${args.name}: ${args.purpose.trim().slice(0, 120)}. If the box you pick is gone, the next row that fits the budget is rented.`,
    columns: COLUMNS,
    rows: offers.map((offer) => rowOf(offer, args.budget)),
    action: "Rent",
    amount: {
      label: "Budget for this rental",
      prefix: "$",
      value: args.budget,
      hint: hintOf(args.purpose),
      perRow: { column: "Hours", rateColumn: "$/h", unit: "h" },
    },
  };
}

async function rent(deps: ToolDeps, args: RentArgs, ctx: ExtensionToolContext): Promise<string> {
  const label = sessionLabel(await deps.owner(), ctx.session, args.name);
  const keys = await deps.keys();
  // A second box under one label would hold no lease of its own and be destroyed.
  const taken = (await listInstances(keys, deps.get)).some((box) => box.label === label);
  if (taken)
    throw new Error(`This session already has a box named ${args.name}: pick another name`);
  const offers = await cardOffers(deps, args);
  if (offers.length === 0) {
    throw new Error(
      `None of the offers can be rented for the budget of ${budgetText(args.budget)} (each is gone, or costs more than that per hour). Nothing was booked. Search again with vast_offers.`,
    );
  }
  const answer = await ctx.pick(cardOf(args, offers));
  if (answer === null) {
    return "The reader chose none of the offers. Nothing was rented and nothing is booked. Ask what to change, then search again.";
  }
  const budget = answer.amount;
  if (budget === null || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("The reader's answer carried no budget, so nothing was rented.");
  }
  const chosen = offers[answer.row];
  if (chosen === undefined)
    throw new Error(`The reader's answer names row ${answer.row}, which is not on the card.`);
  const order = [chosen, ...offers.filter((offer) => offer !== chosen)];
  return await createFirst(deps, { args, label, budget, order, session: ctx.session });
}

type Attempt = { args: RentArgs; label: string; budget: number; order: Offer[]; session: string };

/** Try the offers in order with the confirmed budget; the booking is dropped unless a box was created. */
async function createFirst(deps: ToolDeps, attempt: Attempt): Promise<string> {
  const failures: string[] = [];
  let created = false;
  try {
    for (const [index, offer] of attempt.order.entries()) {
      const box = await tryOffer(deps, attempt, offer, index === 0, failures);
      if (box !== null) {
        created = true;
        return await describe(deps, attempt, offer, box);
      }
    }
  } finally {
    if (!created)
      await updateLeases(leasesPath(deps.folder), (leases) => dropBooking(leases, attempt.label));
  }
  throw new Error(
    `No box was rented and the booking is dropped: ${failures.join("; ")}. The reader's budget was ${budgetText(attempt.budget)}.`,
  );
}

/** Look at the offer again, book the lease and create the box; the box and its lease end, or null with the reason noted. */
async function tryOffer(
  deps: ToolDeps,
  { args, label, budget }: Attempt,
  offer: Offer,
  chosen: boolean,
  failures: string[],
): Promise<{ id: number; until: number } | null> {
  const id = offer.ask_contract_id;
  const fresh = await fetchOffer(id, args.disk_gb, deps.get);
  if (fresh === null) {
    failures.push(`offer ${id} is gone`);
    return null;
  }
  if (fresh.dph_total > budget) {
    failures.push(
      `offer ${id} costs ${rateCell(fresh.dph_total)} per hour, more than the confirmed budget`,
    );
    // The reader chose this one: another box in its place would not be what they approved.
    if (chosen) throw new Error(failures.join("; "));
    return null;
  }
  const now = deps.now();
  const hours = Math.min(MAX_AHEAD_MS / HOUR_MS, budget / fresh.dph_total);
  await updateLeases(leasesPath(deps.folder), (leases) => book(leases, label, hours, now, budget));
  const until = now + hours * HOUR_MS;
  const request = {
    image: args.image,
    disk: args.disk_gb,
    label,
    onstart: args.onstart ?? "sleep infinity",
    env: {
      ...(args.env ?? {}),
      ...Object.fromEntries((args.ports ?? []).map((port) => [`-p ${port}`, "1"])),
    },
  };
  try {
    const box = await withKeys(await deps.keys(), (key) =>
      createInstance(key, id, request, deps.get),
    );
    deps.log("rented", { offer: id, instance: box, label, budget });
    return { id: box, until };
  } catch (caught) {
    if (caught instanceof OfferGone) {
      failures.push(caught.message);
      return null;
    }
    // Offline or a server error: whether a box exists is unknown, so look for it.
    const message = caught instanceof Error ? caught.message : String(caught);
    const existing = (await listInstances(await deps.keys(), deps.get)).find(
      (box) => box.label === label,
    );
    if (existing?.id !== undefined) return { id: existing.id, until };
    failures.push(message);
    return null;
  }
}

async function describe(
  deps: ToolDeps,
  { args, label, budget }: Attempt,
  offer: Offer,
  { id, until }: { id: number; until: number },
): Promise<string> {
  const listed = (await listInstances(await deps.keys(), deps.get)).find((box) => box.id === id);
  const ssh = listed === undefined ? null : sshText(listed, deps.sshKey);
  deps.refresh();
  return [
    `Rented ${args.name}: Vast.ai #${id}, label ${label}.`,
    `Rate: ${dollars(offer.dph_total)}/h. Budget: ${budgetText(budget)}, the reader's confirmed amount: the box is saved and destroyed when it has cost that much.`,
    `Lease until ${endText(until, deps.now())}; vast_extend adds time. vast_cancel ends it.`,
    ssh === null
      ? "ssh: no address yet; vast_boxes shows it once the box is running."
      : `ssh: ${ssh} (works once the box is running)`,
  ].join("\n");
}
