/**
 * `vast_rent`: rent a box only after the reader has seen the price and set the
 * budget.
 *
 * The session proposes offers (best first) and a budget. Each offer is fetched
 * again for today's price, and the ones that are gone, or that could not run
 * an hour within the budget, or whose host end date comes before the budget's
 * runtime (held to 24 hours) plus an hour's margin, are left off. What is left goes on prifly's pick
 * card with the budget as an editable amount; nothing is booked or created
 * before the reader answers. The lease is booked with the amount the reader
 * CONFIRMED, not the one suggested, and its end is held to the hour that budget
 * runs out (and to 24 hours). If the chosen offer is gone by then, the next
 * card rows that still fit the confirmed budget are tried in card order.
 */

import { z } from "zod";
import { type CpuIndex, cpuLink, cpuScores } from "./cpu-score";
import { ACK_TEXT, runwayHours } from "./credit";
import { gpuLink } from "./gpu-link";
import {
  book,
  dropBooking,
  leasesPath,
  MAX_AHEAD_MS,
  type Replace,
  setReplace,
  updateLeases,
} from "./leases";
import {
  endsCell,
  endsTooSoon,
  fetchOffer,
  gpuCell,
  type Offer,
  perfCells,
  placeOf,
  timeLeft,
  vramCell,
} from "./offers";
import type { ExtensionPick, ExtensionTool, ExtensionToolContext } from "./prifly-api";
import { sessionLabel } from "./rules";
import { budgetText, dollars } from "./spend";
import {
  type CreditGuard,
  cardRate,
  confirmOver,
  creditGuard,
  creditNow,
  defineTool,
  endText,
  guardedAmount,
  HOUR_MS,
  hasCells,
  hasLimit,
  hasLinks,
  NAME,
  rateCell,
  sshText,
  type ToolDeps,
} from "./tool-kit";
import { type CreateRequest, createInstance, listInstances, OfferGone, withKeys } from "./vast-api";

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
  "Rent a Vast.ai box. Shows the reader the offers on a card with an editable budget, and what of it the account's credit covers after everything already running on the account, and waits for their answer; only then is a lease booked and the box created. A budget over what the credit covers needs the reader's word that they will top up. Offers that are gone, could not run an hour within the budget, or end (host end date) before the budget runs out plus an hour, are left off. If the chosen offer is gone, the next card row that fits the budget is rented. If the box later turns out broken (ssh refused for 3 minutes, a log showing bad ownership or modes, or stuck in created or loading for 10 minutes), the plugin cancels it and rents the next card row that fits what is left of the confirmed budget by itself, at most 3 times, with no new card. Returns the box's id, label, rate, budget, lease end and ssh command. Use vast_offers first to find offer ids. Never rent any other way.";

/**
 * Run first in every box's onstart so sshd's "bad ownership or modes" check can
 * never lock us out (VAI-35). Errors are dropped and `|| true` keeps `set -e`
 * from ending the script. No `pkill`/HUP: it kills sshd on images that run it
 * in the foreground (VAI-38).
 */
export const SSH_KEY_REPAIR =
  '{ chmod go-w /root; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; sed -i "s/^#*[[:space:]]*StrictModes.*/StrictModes no/" /etc/ssh/sshd_config; } 2>/dev/null || true';

/** The repair, then the caller's onstart (or `sleep infinity`, which keeps the box up). */
export function withSshRepair(onstart?: string): string {
  return `${SSH_KEY_REPAIR}\n${onstart ?? "sleep infinity"}`;
}

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
  "GPU perf · /$",
  "Mem GB/s",
  "CPU",
  "CPU perf · /$",
  "RAM",
  "Disk",
  "Mbps",
  "$/h",
  "Hours",
  "Ends in",
  "Rel.",
  "Verified",
  "Where",
  "Offer",
];
const col = (name: string) => COLUMNS.indexOf(name);
const GPU_COLUMN = col("GPU");
const CPU_COLUMN = col("CPU");
const WHERE_COLUMN = col("Where");
const OFFER_COLUMN = col("Offer");

/** Vast's console, on one offer. Unverified: the console is a single-page app and may ignore `ask`. */
function offerUrl(offer: Offer): string {
  return `https://cloud.vast.ai/?ask=${offer.ask_contract_id}`;
}

/** Hours the box is meant to run: what the budget buys, held to the longest lease. */
export function runHours(offer: Offer, budget: number): number {
  return Math.min(MAX_AHEAD_MS / HOUR_MS, budget / offer.dph_total);
}

/** One card row. `flags`: the Where cell is the bare country code, which a prifly with "pick-cells" draws as a flag. */
function rowOf(
  offer: Offer,
  budget: number,
  now: number,
  cpus: CpuIndex,
  flags: boolean,
): string[] {
  const gb = (mb: number | undefined) => (mb === undefined ? "?" : `${Math.round(mb / 1000)} GB`);
  const perf = perfCells(offer, cpus);
  const place = placeOf(offer.geolocation);
  return [
    gpuCell(offer),
    vramCell(offer),
    perf.gpuPerf === "?" ? "–" : `${perf.gpuPerf} · ${perf.gpuPerDollar}`,
    perf.memBandwidth,
    perf.cpu,
    perf.cpuPerf === "unscored" ? "–" : `${perf.cpuPerf} · ${perf.cpuPerDollar}`,
    gb(offer.cpu_ram),
    `${Math.round(offer.disk_space ?? 0)} GB`,
    perf.down,
    cardRate(offer.dph_total),
    (budget / offer.dph_total).toFixed(1),
    endsCell(offer, now),
    (offer.reliability ?? 0).toFixed(3),
    perf.verified,
    flags && place.code !== null ? place.code : place.text,
    String(offer.ask_contract_id),
  ];
}

/** One link or null per cell: the GPU and CPU names to their PassMark pages, and the offer to Vast's console. */
function linksOf(offer: Offer, cpus: CpuIndex): (string | null)[] {
  const links: (string | null)[] = COLUMNS.map(() => null);
  links[GPU_COLUMN] = gpuLink(offer.gpu_name);
  links[CPU_COLUMN] = cpuLink(offer, cpus);
  links[OFFER_COLUMN] = offerUrl(offer);
  return links;
}

/** Hover text and how to draw the cells that are not plain text: the country as a flag, the offer as a link icon (when its link is sent). */
function cellsOf(
  offer: Offer,
  offerLink: boolean,
): { titles: (string | null)[]; kinds: ("flag" | "link-icon" | null)[] } {
  const titles: (string | null)[] = COLUMNS.map(() => null);
  const kinds: ("flag" | "link-icon" | null)[] = COLUMNS.map(() => null);
  const place = placeOf(offer.geolocation);
  if (place.code !== null) {
    titles[WHERE_COLUMN] = place.full;
    kinds[WHERE_COLUMN] = "flag";
  }
  titles[OFFER_COLUMN] = `Offer ${offer.ask_contract_id} on Vast.ai`;
  if (offerLink) kinds[OFFER_COLUMN] = "link-icon";
  return { titles, kinds };
}

/** Today's offers for the ids, in the session's order, without those gone, too dear for an hour or ending before the budget runs out. */
async function cardOffers(deps: ToolDeps, args: RentArgs): Promise<Offer[]> {
  const ids = [...new Set(args.offers)];
  const found = await Promise.all(ids.map((id) => fetchOffer(id, args.disk_gb, deps.get)));
  return found.flatMap((offer) =>
    offer !== null &&
    offer.dph_total <= args.budget &&
    !endsTooSoon(offer, runHours(offer, args.budget), deps.now())
      ? [offer]
      : [],
  );
}

async function cardOf(
  deps: ToolDeps,
  args: RentArgs,
  offers: readonly Offer[],
  guard: CreditGuard,
): Promise<ExtensionPick> {
  const now = deps.now();
  const cpus = await cpuScores(deps.get, now);
  const links = hasLinks(deps);
  const cells = hasCells(deps);
  return {
    title: `Rent ${args.name}: ${args.purpose.trim().slice(0, 120)}. If the box you pick is gone, the next row that fits the budget is rented.`,
    columns: COLUMNS,
    rows: offers.map((offer) => rowOf(offer, args.budget, now, cpus, cells)),
    ...(links ? { links: offers.map((offer) => linksOf(offer, cpus)) } : {}),
    ...(cells
      ? {
          titles: offers.map((offer) => cellsOf(offer, links).titles),
          cellKinds: offers.map((offer) => cellsOf(offer, links).kinds),
        }
      : {}),
    action: "Rent",
    amount: {
      label: "Budget for this rental",
      prefix: "$",
      value: args.budget,
      perRow: { column: "Hours", rateColumn: "$/h", unit: "h" },
      ...guardedAmount(deps, hintOf(args.purpose), guard),
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
      `None of the offers can be rented for the budget of ${budgetText(args.budget)} (each is gone, costs more than that per hour, or ends before the budget runs out). Nothing was booked. Search again with vast_offers.`,
    );
  }
  // The dearest row's rate: the limit then holds whichever row the reader picks.
  const dearest = Math.max(...offers.map((offer) => offer.dph_total));
  const guard = creditGuard(deps, await creditNow(deps, { label }), dearest, ACK_TEXT);
  const answer = await ctx.pick(await cardOf(deps, args, offers, guard));
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
  const short = await shortfall(deps, ctx, { label, budget, rate: chosen.dph_total });
  if (short === "declined") {
    return "The reader did not rent past what the Vast credit covers. Nothing was rented and nothing is booked.";
  }
  return await createFirst(deps, { args, label, budget, order, session: ctx.session, short });
}

/** What the confirmed budget is over the credit, read again now: null when it fits or the credit is unknown. */
type Short = { over: number; max: number; until: number } | null;

/**
 * Check the confirmed budget against the credit once more. Past it, prifly's
 * card has already had the reader tick "I will top up"; an older prifly's card
 * could not, so they are asked on a second one.
 */
async function shortfall(
  deps: ToolDeps,
  ctx: ExtensionToolContext,
  { label, budget, rate }: { label: string; budget: number; rate: number },
): Promise<Short | "declined"> {
  const credit = await creditNow(deps, { label });
  const limit = creditGuard(deps, credit, rate, ACK_TEXT).limit;
  if (credit === null || limit === undefined || budget <= limit.max) return null;
  const { account, committed } = credit;
  const until = deps.now() + runwayHours(account, committed.burn + rate) * HOUR_MS;
  const short = { over: budget - limit.max, max: limit.max, until };
  deps.log("rent_over_credit", { label, budget, max: limit.max, credit: account.credit });
  if (hasLimit(deps)) return short;
  return (await confirmOver(ctx, { what: "Rent", amount: budget, limit })) ? short : "declined";
}

type Attempt = {
  args: RentArgs;
  label: string;
  budget: number;
  order: Offer[];
  session: string;
  short: Short;
};

/** Try the offers in order with the confirmed budget; the booking is dropped unless a box was created. */
async function createFirst(deps: ToolDeps, attempt: Attempt): Promise<string> {
  const failures: string[] = [];
  let created = false;
  try {
    for (const [index, offer] of attempt.order.entries()) {
      const box = await tryOffer(deps, attempt, offer, index === 0, failures);
      if (box !== null) {
        created = true;
        await keepReplacements(deps, attempt, { offer, index, box });
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

/**
 * Keep with the new box's lease what replaces it if it turns out broken: the
 * rest of the card, what the box was created with, and the budget the reader
 * confirmed. `enforce.ts` rents the replacement from it, with no new card.
 */
async function keepReplacements(
  deps: ToolDeps,
  { label, budget, order }: Attempt,
  {
    offer,
    index,
    box,
  }: { offer: Offer; index: number; box: { id: number; request: CreateRequest } },
): Promise<void> {
  const replace: Replace = {
    offers: order.slice(index + 1).map((o) => o.ask_contract_id),
    excluded: [],
    confirmed: budget,
    spent: 0,
    count: 0,
    request: box.request,
    machine: offer.machine_id ?? null,
    replaces: null,
  };
  await updateLeases(leasesPath(deps.folder), (leases) =>
    setReplace(leases, { box: box.id, label }, replace),
  );
}

/** Why the offer cannot be rented for the confirmed budget, or null when it can. */
export function refusalOf(offer: Offer, budget: number, hours: number, now: number): string | null {
  const id = offer.ask_contract_id;
  if (offer.dph_total > budget) {
    return `offer ${id} costs ${rateCell(offer.dph_total)} per hour, more than the confirmed budget`;
  }
  if (endsTooSoon(offer, hours, now)) {
    return `offer ${id} ends in ${timeLeft(offer, now)}, before the ${hours.toFixed(1)} h the budget runs plus an hour's margin`;
  }
  return null;
}

/** Look at the offer again, book the lease and create the box; the box and its lease end, or null with the reason noted. */
async function tryOffer(
  deps: ToolDeps,
  { args, label, budget }: Attempt,
  offer: Offer,
  chosen: boolean,
  failures: string[],
): Promise<{ id: number; until: number; request: CreateRequest } | null> {
  const id = offer.ask_contract_id;
  const fresh = await fetchOffer(id, args.disk_gb, deps.get);
  if (fresh === null) {
    failures.push(`offer ${id} is gone`);
    return null;
  }
  const now = deps.now();
  const hours = runHours(fresh, budget);
  const refusal = refusalOf(fresh, budget, hours, now);
  if (refusal !== null) {
    failures.push(refusal);
    // The reader chose this one: another box in its place would not be what they approved.
    if (chosen) throw new Error(failures.join("; "));
    return null;
  }
  await updateLeases(leasesPath(deps.folder), (leases) => book(leases, label, hours, now, budget));
  const until = now + hours * HOUR_MS;
  const request = {
    image: args.image,
    disk: args.disk_gb,
    label,
    onstart: withSshRepair(args.onstart),
    env: {
      ...(args.env ?? {}),
      ...Object.fromEntries((args.ports ?? []).map((port) => [`-p ${port}`, "1"])),
    },
  };
  try {
    const box = await withKeys(await deps.keys(), (key) =>
      createInstance(key, id, request, deps.get),
    );
    deps.log("rented", { offer: id, instance: box, label, budget, until, rate: fresh.dph_total });
    return { id: box, until, request };
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
    if (existing?.id !== undefined) return { id: existing.id, until, request };
    failures.push(message);
    return null;
  }
}

async function describe(
  deps: ToolDeps,
  { args, label, budget, short }: Attempt,
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
    ...(short === null
      ? []
      : [
          `The budget is ${dollars(short.over)} more than the Vast credit covers (${budgetText(short.max)}); the reader said they will top up. At the account's burn the credit runs out about ${endText(short.until, deps.now())}: remind them to top up at console.vast.ai → Billing before then, or Vast stops every box on the account.`,
        ]),
    ssh === null
      ? "ssh: no address yet; vast_boxes shows it once the box is running."
      : `ssh: ${ssh} (works once the box is running)`,
  ].join("\n");
}
