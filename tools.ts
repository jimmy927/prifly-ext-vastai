/**
 * The MCP tools this extension serves to every session prifly runs
 * (`api.tools?.register`): the only way a session rents, extends, cancels or
 * inspects a Vast.ai box. `rent.ts` has `vast_rent`.
 *
 * Each tool acts on this session's boxes only — those whose label carries the
 * session's first 8 characters under this owner. Money questions go to the
 * reader on prifly's pick card, with the amount as an editable field; what the
 * reader confirms is what is booked.
 */

import { z } from "zod";
import { available, RAISE_ACK, runwayHours } from "./credit";
import {
  cancel,
  extend,
  find,
  type Lease,
  type LeaseTarget,
  leaseOf,
  leasesPath,
  raiseBudget,
  readLeases,
  updateLeases,
} from "./leases";
import { endsInText, type OfferFilters, searchOffers, shareText, vramText } from "./offers";
import type { ExtensionTool, ExtensionToolContext } from "./prifly-api";
import { rentTool } from "./rent";
import { MAX_REPLACEMENTS } from "./replace";
import { EXPIRY_MARGIN_MS, hostEnd, span } from "./rules";
import { budgetEnd, budgetText, costAt, dollars, spentLine, spentOf } from "./spend";
import {
  boxLabels,
  confirmOver,
  creditGuard,
  creditNow,
  defineTool,
  endText,
  guardedAmount,
  HOUR_MS,
  hasLimit,
  NAME,
  type OwnBox,
  ownBoxes,
  pickBox,
  rateCell,
  sshText,
  type ToolDeps,
} from "./tool-kit";
import { type Instance, requestLogs, withKeys } from "./vast-api";

export function makeTools(deps: ToolDeps): ExtensionTool[] {
  return [
    offersTool(deps),
    rentTool(deps),
    boxesTool(deps),
    logsTool(deps),
    extendTool(deps),
    cancelTool(deps),
  ];
}

const OffersArgs = z.strictObject({
  gpu: z.string().optional().describe("Part of the GPU's name, any case: 4090, A2000"),
  min_vram_gb: z
    .number()
    .positive()
    .optional()
    .describe("Least VRAM in GB (1 GB = 1000 MB here, so a 24 GB card matches 24)"),
  min_cpu_cores: z
    .number()
    .positive()
    .optional()
    .describe("Least CPU threads you get (cpu_cores_effective)"),
  min_ram_gb: z.number().positive().optional(),
  min_disk_gb: z
    .number()
    .positive()
    .optional()
    .describe("Least free disk on the host; also the disk the rate is priced with (default 10)"),
  max_dph: z.number().positive().optional().describe("Most dollars per hour, disk included"),
  min_reliability: z
    .number()
    .min(0)
    .max(1)
    .default(0.98)
    .describe("Host reliability floor; below 0.98 hosts drop jobs"),
  region: z.string().optional().describe("Part of the location, any case: SE, Sweden, US"),
  min_inet_down_mbps: z.number().positive().optional(),
  min_hours: z
    .number()
    .positive()
    .optional()
    .describe(
      "Hours the box must stay rentable; hosts set an end date after which Vast stops the box. Offers with no end date always pass.",
    ),
  limit: z.number().int().min(1).max(50).default(10),
});

function offersTool(deps: ToolDeps): ExtensionTool {
  return defineTool(
    "vast_offers",
    "Search Vast.ai's rentable GPU machines (no key, nothing is rented). Returns the cheapest offers that pass the filters, cheapest first, one line each with the offer id to give to vast_rent. A machine with no GPU is never listed. The marketplace answers at most 64 offers per search, so narrow the filters rather than asking for more.",
    OffersArgs,
    async (args) => {
      const filters: OfferFilters = {
        gpu: args.gpu,
        minVramGb: args.min_vram_gb,
        minCpuCores: args.min_cpu_cores,
        minRamGb: args.min_ram_gb,
        minDiskGb: args.min_disk_gb,
        maxDph: args.max_dph,
        minReliability: args.min_reliability,
        region: args.region,
        minInetDownMbps: args.min_inet_down_mbps,
        minHours: args.min_hours,
        limit: args.limit,
      };
      const offers = await searchOffers(filters, deps.get);
      if (offers.length === 0) return "No offers pass these filters. Loosen one and search again.";
      const now = deps.now();
      const lines = offers.map((o) => {
        const gpus = (o.num_gpus ?? 1) > 1 ? `${o.num_gpus}x ` : "";
        return `offer ${o.ask_contract_id}: ${gpus}${o.gpu_name ?? "?"} · ${shareText(o)} · ${vramText(o)} VRAM · ${Math.round(o.cpu_cores_effective ?? 0)} cores · ${Math.round((o.cpu_ram ?? 0) / 1000)} GB RAM · ${Math.round(o.disk_space ?? 0)} GB disk · ${rateCell(o.dph_total)}/h · reliability ${(o.reliability ?? 0).toFixed(3)} · ${o.geolocation ?? "?"} · ${Math.round(o.inet_down ?? 0)} Mbps down · ${endsInText(o, now)}`;
      });
      return `${lines.join("\n")}\n\nRates include the disk. Offers go in a moment: vast_rent looks each up again.`;
    },
  );
}

/** One line for a box: status, rate, spend of budget, lease end, ssh. */
function boxLine({ box, id, name }: OwnBox, lease: Lease | null, deps: ToolDeps): string {
  const now = deps.now();
  const status = box.actual_status ?? box.intended_status ?? "?";
  const spent = spentOf(box, now);
  const spend =
    lease?.budget != null && spent !== null
      ? spentLine(spent, lease.budget)
      : `${spent === null ? "?" : dollars(spent)} spent, no budget`;
  const ends = lease === null ? "no lease" : `lease until ${endText(lease.until, now)}`;
  const hostEnds = hostEnd(box);
  const host = hostEnds === null ? "" : ` · host end date ${endText(hostEnds, now)}`;
  const ssh = sshText(box, deps.sshKey);
  const replaces = lease?.replace?.replaces;
  const replaced =
    replaces == null
      ? ""
      : ` · replaces #${replaces.box} — ${replaces.reason} (replacement ${lease?.replace?.count ?? 0} of ${MAX_REPLACEMENTS})`;
  return `${name} (#${id}): ${status} · ${dollars(box.dph_total ?? 0)}/h · ${spend} · ${ends}${host}${replaced}${ssh === null ? "" : ` · ${ssh}`}`;
}

function boxesTool(deps: ToolDeps): ExtensionTool {
  return defineTool(
    "vast_boxes",
    "The Vast.ai account's credit, burn and runway, then this session's boxes with status, rate, spent of budget, lease end, the host's end date (when the box is saved and destroyed 30 minutes before) and ssh command. Boxes of other sessions are not listed, but their spend is in the account line.",
    z.strictObject({}),
    async (_args, ctx) => {
      const [boxes, leases, credit] = await Promise.all([
        ownBoxes(deps, ctx.session),
        readLeases(leasesPath(deps.folder)),
        creditNow(deps),
      ]);
      const lines = boxes.map((b) => boxLine(b, leaseOf(leases, b.id, b.label), deps));
      return [
        accountLine(credit),
        ...(lines.length === 0 ? ["This session has no Vast.ai boxes."] : lines),
      ].join("\n");
    },
  );
}

/** "Account: credit $48.62 · burn $1.35/h · runway 36 h · committed $41.30". */
function accountLine(credit: Awaited<ReturnType<typeof creditNow>>): string {
  if (credit === null) return "Account: credit unknown (Vast.ai did not answer).";
  const { account, committed } = credit;
  const hours = runwayHours(account, committed.burn);
  const runway = Number.isFinite(hours) ? span(hours * HOUR_MS) : "no end (nothing bills)";
  const short =
    committed.total > available(account)
      ? ` · the credit does not cover what is committed: top up at console.vast.ai → Billing`
      : "";
  return `Account: credit ${dollars(account.credit)} · burn ${dollars(committed.burn)}/h · runway ${runway} · committed ${dollars(committed.total)}${short}`;
}

function logsTool(deps: ToolDeps): ExtensionTool {
  const schema = z.strictObject({
    name: z.string().describe("The box's name, or its Vast.ai id"),
    tail: z.number().int().min(1).max(2000).default(200).describe("How many of the last lines"),
  });
  return defineTool(
    "vast_logs",
    "The end of the container logs of one of this session's boxes. For a box that never reaches running, or an ssh that is refused.",
    schema,
    async (args, ctx) => {
      const { id } = pickBox(await ownBoxes(deps, ctx.session), args.name);
      const text = await withKeys(await deps.keys(), (key) =>
        requestLogs(key, id, args.tail, deps.get, deps.sleep),
      );
      return text.split("\n").slice(-args.tail).join("\n");
    },
  );
}

/** The lease a command means: the id once bound, else the booking for the label. */
function targetOf(lease: Lease): LeaseTarget {
  return lease.box === null ? { label: lease.label } : { box: lease.box };
}

/** A budget to suggest that covers `need`: whole dollars from ten up, five cents below. */
function suggestion(need: number): number {
  const step = need >= 10 ? 1 : 0.05;
  return Number((Math.ceil(need / step - 1e-9) * step).toFixed(2));
}

const ExtendArgs = z.strictObject({
  name: z.string().describe("The box's name, or its Vast.ai id"),
  hours: z.number().positive().max(24).describe("Hours to add to the lease"),
});

function extendTool(deps: ToolDeps): ExtensionTool {
  return defineTool(
    "vast_extend",
    "Add hours to one of this session's boxes' leases. Free while the box's cost to the new end stays within its budget; otherwise the reader is asked, on a card, to raise the budget, and the box is extended as far as the budget they confirm allows. A lease reaches at most 24 hours ahead, and never past 30 minutes before the host's end date, when the box is saved and destroyed.",
    ExtendArgs,
    async (args, ctx) => {
      const box = pickBox(await ownBoxes(deps, ctx.session), args.name);
      const lease = leaseOf(await readLeases(leasesPath(deps.folder)), box.id, box.label);
      if (lease === null) {
        throw new Error(
          `${box.name} has no lease: it is destroyed soon. Rent a new box with vast_rent.`,
        );
      }
      const now = deps.now();
      const from = Math.max(lease.until, now);
      const hostCap = hostCapOf(box.box);
      if (hostCap !== null && hostCap <= from) {
        return await applyExtension(deps, box, lease, args.hours, null);
      }
      const wanted = Math.min(from + args.hours * HOUR_MS, hostCap ?? Number.POSITIVE_INFINITY);
      const need = costAt(box.box, wanted);
      if (lease.budget === null || need === null || need <= lease.budget + 1e-9) {
        return await applyExtension(deps, box, lease, args.hours, null);
      }
      const confirmed = await askRaise(deps, ctx, { box, lease, hours: args.hours, need, wanted });
      if (confirmed === null) {
        return `The reader did not raise the budget: ${box.name} keeps its lease until ${endText(lease.until, now)} and its budget of ${budgetText(lease.budget)}.`;
      }
      const spent = spentOf(box.box, now);
      if (spent !== null && confirmed <= spent) {
        return `The confirmed budget ${budgetText(confirmed)} is not above what ${box.name} has already cost (${dollars(spent)}), so nothing was changed. vast_cancel ends the box.`;
      }
      return await applyExtension(deps, box, lease, args.hours, confirmed);
    },
  );
}

/** The latest a lease may end for this box: `EXPIRY_MARGIN_MS` before the host's end date; null when it has none. */
function hostCapOf(box: Instance): number | null {
  const end = hostEnd(box);
  return end === null ? null : end - EXPIRY_MARGIN_MS;
}

type Raise = { box: OwnBox; lease: Lease; hours: number; need: number; wanted: number };

/** Ask the reader for a new budget on a one-row card; their amount, or null when they chose none. */
async function askRaise(
  deps: ToolDeps,
  ctx: ExtensionToolContext,
  { box, lease, hours, need, wanted }: Raise,
): Promise<number | null> {
  const rate = box.box.dph_total ?? 0;
  const spent = spentOf(box.box, deps.now()) ?? 0;
  const credit = await creditNow(deps, { box: box.id });
  const guard = creditGuard(deps, credit, rate, RAISE_ACK, spent);
  const hint = `Suggested by Claude: ${hours} more hours at ${rateCell(rate)} per hour, ${dollars(need)} in all. The box is saved and destroyed when it has cost this much.`;
  const answer = await ctx.pick({
    title: `Raise the budget of ${box.name}? ${hours} more hours would cost ${dollars(need)} in all, more than its budget of ${budgetText(lease.budget ?? 0)}.`,
    columns: ["Box", "$/h", "Spent", "Budget", "Extend by", "New lease end"],
    rows: [
      [
        box.name,
        rateCell(rate),
        dollars(spent),
        budgetText(lease.budget ?? 0),
        `${hours} h`,
        endText(wanted, deps.now()),
      ],
    ],
    action: "Raise budget",
    amount: {
      label: `New budget for ${box.name}`,
      prefix: "$",
      value: suggestion(need),
      ...guardedAmount(deps, hint, guard),
    },
  });
  if (answer === null) return null;
  if (answer.amount === null || !Number.isFinite(answer.amount) || answer.amount <= 0) {
    throw new Error("The reader's answer carried no budget, so nothing was changed.");
  }
  const { limit } = guard;
  if (limit === undefined || answer.amount <= limit.max) return answer.amount;
  deps.log("raise_over_credit", { instance: box.id, budget: answer.amount, max: limit.max });
  if (hasLimit(deps)) return answer.amount;
  const sure = await confirmOver(ctx, { what: "Raise", amount: answer.amount, limit });
  return sure ? answer.amount : null;
}

/** Raise the budget if one was confirmed, then add as many of the hours as the budget allows. */
async function applyExtension(
  deps: ToolDeps,
  { box, name }: Pick<OwnBox, "box" | "name">,
  lease: Lease,
  hours: number,
  confirmed: number | null,
): Promise<string> {
  const now = deps.now();
  const budget = confirmed ?? lease.budget;
  const from = Math.max(lease.until, now);
  const limit = budget === null ? null : budgetEnd(box, budget);
  const hostCap = hostCapOf(box);
  const end = Math.min(
    from + hours * HOUR_MS,
    limit ?? Number.POSITIVE_INFINITY,
    hostCap ?? Number.POSITIVE_INFINITY,
  );
  const allowed = (end - from) / HOUR_MS;
  const target = targetOf(lease);
  const next = await updateLeases(leasesPath(deps.folder), (leases) => {
    const raised =
      confirmed === null
        ? { leases: [...leases], result: lease }
        : raiseBudget(leases, target, confirmed);
    return allowed > 0 ? extend(raised.leases, target, allowed, now) : raised;
  });
  deps.log("extended", {
    instance: box.id ?? 0,
    until: next.until,
    budget: next.budget,
    by: "session",
  });
  deps.refresh();
  const cost = budget === null ? "" : `, budget ${budgetText(budget)}`;
  const note = limitNote({ box, hours, from, end, hostCap, budgetLimited: budget !== null }, now);
  return [
    allowed > 0
      ? `${name}'s lease now runs until ${endText(next.until, now)}${cost}.`
      : `${name}'s lease is unchanged (until ${endText(next.until, now)})${cost}.`,
    note,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

type Limited = {
  box: Instance;
  hours: number;
  from: number;
  end: number;
  hostCap: number | null;
  budgetLimited: boolean;
};

/** What to tell the reader when fewer hours were added than asked: the host's end date or the budget, whichever held it; "" when all fit. */
function limitNote(
  { box, hours, from, end, hostCap, budgetLimited }: Limited,
  now: number,
): string {
  if (end - from >= hours * HOUR_MS - 1) return "";
  const fit = end > from ? ` Only ${span(end - from)} of the ${hours} hours fit.` : "";
  const hostEnds = hostEnd(box);
  if (hostCap !== null && hostEnds !== null && end >= hostCap - 1) {
    return `The host's end date limits it: ${endText(hostEnds, now)}. Vast.ai stops the box then, so it is saved and destroyed ${span(EXPIRY_MARGIN_MS)} before.${fit}`;
  }
  if (!budgetLimited) return "";
  const spent = spentOf(box, now);
  return `Only ${span(Math.max(0, end - from))} of the ${hours} hours fit the budget${spent === null ? "" : ` (spent ${dollars(spent)})`}.`;
}

function cancelTool(deps: ToolDeps): ExtensionTool {
  return defineTool(
    "vast_cancel",
    "End one of this session's boxes' leases now: the box is saved (/root/.lease/save, if it has one) and destroyed within a minute. A booking nothing was rented for is just dropped.",
    z.strictObject({ name: z.string().describe("The box's name (or its Vast.ai id)") }),
    async (args, ctx) => {
      const owner = await deps.owner();
      const path = leasesPath(deps.folder);
      const leases = await readLeases(path);
      const label = leaseLabel(leases, owner, ctx.session, args.name);
      const lease = await updateLeases(path, (current) => cancel(current, { label }));
      if (lease.box !== null) deps.log("cancelled", { instance: lease.box, label });
      deps.refresh();
      return lease.box === null
        ? `Dropped the booking for ${args.name}.`
        : `Cancelled: ${args.name} (#${lease.box}) is saved and destroyed within a minute.`;
    },
  );
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
