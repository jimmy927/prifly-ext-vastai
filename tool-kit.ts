/** What the tools in `tools.ts` and `rent.ts` share: their dependencies, argument parsing, and finding a session's boxes. */

import { z } from "zod";
import {
  type Account,
  type Committed,
  type CreditConfig,
  committedOf,
  creditLine,
  maxBudget,
  overText,
} from "./credit";
import { leasesPath, readLeases } from "./leases";
import type { ExtensionApi, ExtensionTool, ExtensionToolContext, PickAmount } from "./prifly-api";
import { parseLabel, sessionLabel, span } from "./rules";
import { sshCommand } from "./run";
import { budgetText, dollars } from "./spend";
import { type Fetch, getAccount, type Instance, listInstances, withKeys } from "./vast-api";

/** Everything the tools reach outside themselves, so a test can hand in fakes. */
export type ToolDeps = {
  /** Where `leases.json` is kept. */
  folder: string;
  /** This prifly's label owner, read afresh: see `owner.ts`. */
  owner: () => Promise<string>;
  sshKey: string | null;
  keys: () => Promise<string[]>;
  get: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  /** Ask the display to list the boxes again now. */
  refresh: () => void;
  log: ExtensionApi["log"];
  /** What the prifly host can do beyond the base contract (`api.features`). */
  features: readonly string[];
  credit: CreditConfig;
};

/** Whether this prifly's pick card takes `amount.limit`. */
export function hasLimit(deps: ToolDeps): boolean {
  return deps.features.includes("pick-amount-limit");
}

/** Whether this prifly's pick card takes `links`. */
export function hasLinks(deps: ToolDeps): boolean {
  return deps.features.includes("pick-links");
}

/** Whether this prifly's pick card takes `titles` and `cellKinds`. */
export function hasCells(deps: ToolDeps): boolean {
  return deps.features.includes("pick-cells");
}

/**
 * The rate on the rent card: "0.45", three decimals under $0.10 so a cheap
 * box's rate is not rounded away. It stays a number: prifly divides the
 * budget by this cell for the Hours column.
 */
export function cardRate(rate: number): string {
  return rate.toFixed(rate < 0.1 ? 3 : 2);
}

/** The account's credit and what is committed on it, without `except`; null when Vast.ai does not say. */
export async function creditNow(
  deps: ToolDeps,
  except: { box?: number; label?: string } = {},
): Promise<{ account: Account; committed: Committed } | null> {
  try {
    const keys = await deps.keys();
    const [account, boxes, leases] = await Promise.all([
      withKeys(keys, (key) => getAccount(key, deps.get)),
      listInstances(keys, deps.get),
      readLeases(leasesPath(deps.folder)),
    ]);
    return { account, committed: committedOf(boxes, leases, deps.now(), deps.credit, except) };
  } catch (caught) {
    deps.log("credit_read_failed", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
    return null;
  }
}

/** A box name: at most 8 characters, so short displays show it whole. */
export const NAME = /^[A-Za-z0-9_-]{1,8}$/;

export const HOUR_MS = 3_600_000;

/** The arguments a tool was called with, checked: a throw says what is wrong, for the session to fix. */
export function parseArgs<S extends z.ZodType>(
  schema: S,
  args: Record<string, unknown>,
): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error(`Bad arguments:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** A tool whose input schema is its zod schema, so the two cannot differ. */
export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, ctx: ExtensionToolContext) => Promise<string>,
): ExtensionTool {
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(schema);
  return {
    name,
    description,
    inputSchema,
    call: async (args, ctx) => await run(parseArgs(schema, args), ctx),
  };
}

/** The labels a session's box of this name may carry: this owner's, then the older one with none. */
export function boxLabels(owner: string, session: string, name: string): string[] {
  return [sessionLabel(owner, session, name), `s-${session.slice(0, 8)}/${name}`];
}

export type OwnBox = { box: Instance; id: number; name: string; label: string };

/** The account's boxes that this session rented: its 8 characters start the label, under this owner. */
export async function ownBoxes(deps: ToolDeps, session: string): Promise<OwnBox[]> {
  const [owner, keys] = await Promise.all([deps.owner(), deps.keys()]);
  const boxes = await listInstances(keys, deps.get);
  return boxes.flatMap((box) => {
    const label = box.label ?? "";
    const parsed = parseLabel(label);
    const mine =
      parsed !== null &&
      session.startsWith(parsed.session) &&
      (parsed.owner === null || parsed.owner === owner);
    return box.id === undefined || !mine ? [] : [{ box, id: box.id, name: parsed.name, label }];
  });
}

/** One of this session's boxes by its name or Vast.ai id. */
export function pickBox(boxes: readonly OwnBox[], which: string): OwnBox {
  const found = boxes.find((b) => b.name === which || String(b.id) === which);
  if (found === undefined) {
    const names = boxes.map((b) => b.name).join(", ");
    throw new Error(
      `This session has no box ${which}${names === "" ? " (it has no boxes)" : `; its boxes are ${names}`}`,
    );
  }
  return found;
}

/** "14:05 (2h 5m left)", or "ended 14:05" past it. */
export function endText(until: number, now: number): string {
  const at = new Date(until).toLocaleTimeString([], { timeStyle: "short" });
  return until > now ? `${at} (${span(until - now)} left)` : `ended ${at}`;
}

/** An ssh command for a box, or null while Vast.ai has not given it an address. */
export function sshText(box: Instance, sshKey: string | null): string | null {
  const { ssh_host: host, ssh_port: port } = box;
  return host === undefined || port === undefined ? null : sshCommand(host, port, sshKey).join(" ");
}

/** "0.485": a rate for a table cell the pick card does arithmetic on. */
export function rateCell(rate: number): string {
  return rate.toFixed(3);
}

/** What a money card says of the account's credit: its limit, or a note when Vast.ai did not say. */
export type CreditGuard = { limit: PickAmount["limit"]; note: string };

/**
 * The limit for a budget of a box billing `rate` an hour: what it has `spent`
 * already (0 for a box not rented yet), plus what the credit covers after
 * everything else committed and the margin. `ack` is the reader's word to go past it.
 */
export function creditGuard(
  deps: ToolDeps,
  credit: { account: Account; committed: Committed } | null,
  rate: number,
  ack: string,
  spent = 0,
): CreditGuard {
  if (credit === null) {
    return { limit: undefined, note: "Vast credit unknown: Vast.ai did not answer." };
  }
  const { account, committed } = credit;
  const rest = maxBudget(account, committed, rate, deps.credit);
  const max = spent === 0 ? rest : Math.floor((spent + rest) * 100) / 100;
  return {
    limit: {
      max,
      text: creditLine(account, committed, max, rate, deps.credit, spent),
      over: overText(committed, max),
      ack,
    },
    note: "",
  };
}

/**
 * The amount field's hint and limit: the limit where prifly draws one; on an
 * older prifly its words go in the hint, so the reader still sees them.
 */
export function guardedAmount(
  deps: ToolDeps,
  hint: string,
  guard: CreditGuard,
): Pick<PickAmount, "hint" | "limit"> {
  const words = hasLimit(deps) ? guard.note : (guard.limit?.text ?? guard.note);
  return {
    hint: words === "" ? hint : `${hint} ${words}`,
    ...(hasLimit(deps) && guard.limit !== undefined ? { limit: guard.limit } : {}),
  };
}

/**
 * An amount past the limit, on a prifly whose card could not ask for the
 * reader's word: ask on a second card. True when they gave it.
 */
export async function confirmOver(
  ctx: ExtensionToolContext,
  {
    what,
    amount,
    limit,
  }: { what: string; amount: number; limit: NonNullable<PickAmount["limit"]> },
): Promise<boolean> {
  const short = amount - limit.max;
  const answer = await ctx.pick({
    title: `${what} anyway? A budget of ${budgetText(amount)} is ${dollars(short)} more than the Vast credit covers. ${limit.over}`,
    columns: ["Budget", "Credit covers", "Short by"],
    rows: [[budgetText(amount), budgetText(limit.max), dollars(short)]],
    action: limit.ack,
  });
  return answer !== null;
}
