/**
 * The Vast.ai account's credit against what is already committed on it, as
 * pure functions of what the extension has seen.
 *
 * Every box on the account draws on one credit: this prifly's boxes, other
 * prifly's, boxes rented by hand, and serverless endpoints' workers (labelled
 * `<endpoint>:<endpoint id>:<group id>`). When the credit falls below the
 * account's `balance_threshold`, Vast.ai stops every one of them at once. A
 * running box bills `dph_total` an hour; a stopped one bills its disk,
 * `storage_total_cost` an hour.
 *
 * What is committed: a box of this prifly with a budget will cost the rest of
 * its budget (`vast_extend` is free within it); every other box its burn for
 * `horizonHours`; a booking not rented yet its budget. A new budget fits when
 * it, the committed spend and a margin together stay within the credit.
 */

import type { Lease } from "./leases";
import { leaseOf } from "./leases";
import { parseLabel } from "./rules";
import { budgetText, dollars, spentOf } from "./spend";
import type { Instance } from "./vast-api";

const HOUR_MS = 3_600_000;

/** `credit` in `config.json`: the margin kept free, and when the reader is told the credit runs short. */
export type CreditConfig = {
  /** Kept free on top of a new budget and what is committed: this share of the two… */
  marginPercent: number;
  /** …or this many hours of the account's burn, the new box included, whichever is more. */
  marginHours: number;
  /** How long a box with no budget, or a serverless worker, is counted to keep burning. */
  horizonHours: number;
  /** Hours of runway at which the reader is told, once each. */
  warnHours: number[];
};

export const CREDIT_DEFAULTS: CreditConfig = {
  marginPercent: 10,
  marginHours: 3,
  horizonHours: 24,
  warnHours: [12, 3, 1],
};

/** What the account has to spend: its credit, and the balance at which Vast.ai stops every box (null when that is off). */
export type Account = { credit: number; threshold: number | null };

/** One thing already committed on the account, named for the card. */
export type Commitment = {
  kind: "budget" | "booking" | "serverless" | "other";
  name: string;
  dollars: number;
};

/** What the credit has to cover: the commitments, their sum, and the account's burn now. */
export type Committed = { items: Commitment[]; total: number; burn: number };

/** A serverless endpoint's worker: `rj-judge:39180:49020`. */
const WORKER_LABEL = /^(.+):\d+:\d+$/;

export function isRunning(box: Instance): boolean {
  return (box.actual_status ?? box.intended_status) === "running";
}

/** Dollars an hour this box bills now: its rate running, its disk stopped. */
export function burnOf(box: Instance): number {
  return isRunning(box) ? (box.dph_total ?? 0) : (box.storage_total_cost ?? 0);
}

/** Dollars an hour the whole account bills now. */
export function accountBurn(boxes: readonly Instance[]): number {
  return boxes.reduce((sum, box) => sum + burnOf(box), 0);
}

/** Dollars the credit can fall by before Vast.ai stops every box. */
export function available(account: Account): number {
  return account.credit - Math.max(0, account.threshold ?? 0);
}

/**
 * What each box, and each booking not rented yet, is still going to cost.
 * `except` leaves one box (by id) or booking (by label) out: the one a card is
 * asking about.
 */
export function committedOf(
  boxes: readonly Instance[],
  leases: readonly Lease[],
  now: number,
  config: CreditConfig,
  except: { box?: number; label?: string } = {},
): Committed {
  const counted = boxes.filter((box) => box.id !== undefined && box.id !== except.box);
  const labels = new Set(boxes.map((box) => box.label ?? ""));
  const bookings = leases.filter(
    (lease) =>
      lease.box === null &&
      !lease.cancelled &&
      lease.label !== except.label &&
      !labels.has(lease.label),
  );
  const items: Commitment[] = [
    ...counted.map((box) => boxCommitment(box, leases, now, config)),
    ...bookings.map((lease) => ({
      kind: "booking" as const,
      name: parseLabel(lease.label)?.name ?? lease.label,
      dollars: lease.budget ?? 0,
    })),
  ];
  const kept = items.filter((item) => item.dollars > 0.005);
  return {
    items: kept,
    total: kept.reduce((sum, item) => sum + item.dollars, 0),
    burn: accountBurn(boxes.filter((box) => box.id !== except.box)),
  };
}

/**
 * What one box is still going to cost: a running box with a budget the rest of
 * it; a leased box with none its burn to the lease's end; any other its burn
 * for `horizonHours`.
 */
function boxCommitment(
  box: Instance,
  leases: readonly Lease[],
  now: number,
  config: CreditConfig,
): Commitment {
  const label = box.label ?? "";
  const lease = leaseOf(leases, box.id ?? -1, label);
  const name = parseLabel(label)?.name ?? (label || `#${box.id}`);
  const spent = spentOf(box, now);
  if (lease?.budget != null && spent !== null && isRunning(box)) {
    return { kind: "budget", name, dollars: Math.max(0, lease.budget - spent) };
  }
  const worker = WORKER_LABEL.exec(label);
  const hours =
    lease !== null && lease.budget === null
      ? Math.max(0, lease.until - now) / HOUR_MS
      : config.horizonHours;
  return {
    kind: worker === null ? "other" : "serverless",
    name: worker?.[1] ?? name,
    dollars: burnOf(box) * hours,
  };
}

/** The margin kept free with a budget of `budget` for a box billing `rate` an hour. */
export function marginOf(
  budget: number,
  committed: Committed,
  rate: number,
  config: CreditConfig,
): number {
  return Math.max(
    (config.marginPercent / 100) * (budget + committed.total),
    config.marginHours * (committed.burn + rate),
  );
}

/**
 * The largest budget, for a box billing `rate` an hour, that the credit covers
 * after what is committed and the margin: whole dollars from ten up, else
 * cents; 0 when nothing fits.
 */
export function maxBudget(
  account: Account,
  committed: Committed,
  rate: number,
  config: CreditConfig,
): number {
  const free = available(account) - committed.total;
  const byShare = free / (1 + config.marginPercent / 100);
  const byHours = free - config.marginHours * (committed.burn + rate);
  const most = Math.min(byShare, byHours);
  if (!(most > 0)) return 0;
  return most >= 10 ? Math.floor(most) : Math.floor(most * 100) / 100;
}

/** Hours until the credit reaches the threshold at `burn` dollars an hour; Infinity when nothing bills. */
export function runwayHours(account: Account, burn: number): number {
  if (burn <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, available(account)) / burn;
}

/** "jtrain2: $38.20 left of its budget · serverless rj-judge, rj-reranker: $3.10 over 24 h". */
export function commitmentText(items: readonly Commitment[], config: CreditConfig): string {
  const sum = (kind: Commitment["kind"]) =>
    items.filter((item) => item.kind === kind).reduce((total, item) => total + item.dollars, 0);
  const names = (kind: Commitment["kind"]) =>
    [...new Set(items.filter((item) => item.kind === kind).map((item) => item.name))].join(", ");
  const parts = [
    ...items
      .filter((item) => item.kind === "budget")
      .map((item) => `${item.name}: ${dollars(item.dollars)} left of its budget`),
    ...items
      .filter((item) => item.kind === "booking")
      .map((item) => `booking ${item.name}: ${dollars(item.dollars)}`),
  ];
  if (sum("serverless") > 0) {
    parts.push(
      `serverless ${names("serverless")}: ${dollars(sum("serverless"))} over ${config.horizonHours} h`,
    );
  }
  if (sum("other") > 0) {
    parts.push(`other boxes ${names("other")}: ${dollars(sum("other"))} at most`);
  }
  return parts.join(" · ");
}

/**
 * The line on the card: "Vast credit $120.00 − committed $41.30 (…) − margin
 * $16.70 → covers a budget up to $62." `max` is the budget as the card shows
 * it; for a box running already, `spent` of it is spent and only the rest
 * still draws on the credit.
 */
export function creditLine(
  account: Account,
  committed: Committed,
  max: number,
  rate: number,
  config: CreditConfig,
  spent = 0,
): string {
  const what = commitmentText(committed.items, config);
  const owed = `committed ${dollars(committed.total)}${what === "" ? "" : ` (${what})`}`;
  const margin = dollars(marginOf(Math.max(0, max - spent), committed, rate, config));
  const already = spent > 0 ? ` (${dollars(spent)} of it spent already)` : "";
  const covers =
    max > spent
      ? `covers a budget up to ${budgetText(max)}${already}`
      : spent > 0
        ? "covers no more budget"
        : "covers no budget at all";
  return `Vast credit ${dollars(account.credit)} − ${owed} − margin ${margin} → ${covers}.`;
}

/** The warning once the amount is over the limit: what happens at $0, and how to top up. */
export function overText(committed: Committed, max: number): string {
  const running = committed.items
    .filter((item) => item.kind === "budget")
    .map((item) => item.name)
    .join(", ");
  const keep = max > 0 ? `, or keep the budget at ${budgetText(max)} or less` : "";
  return `More than the credit covers. When the credit reaches $0, Vast stops every box on the account${running === "" ? "" : `, ${running} included`}. Top up at console.vast.ai → Billing${keep}.`;
}

/** The reader's word to go past the credit, on the rent card and the raise card. */
export const ACK_TEXT = "Rent anyway: I will top up before the credit runs out";
export const RAISE_ACK = "Raise anyway: I will top up before the credit runs out";
