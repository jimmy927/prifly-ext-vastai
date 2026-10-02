/** What the tools in `tools.ts` and `rent.ts` share: their dependencies, argument parsing, and finding a session's boxes. */

import { z } from "zod";
import type { ExtensionApi, ExtensionTool, ExtensionToolContext } from "./prifly-api";
import { parseLabel, sessionLabel, span } from "./rules";
import { sshCommand } from "./run";
import { type Fetch, type Instance, listInstances } from "./vast-api";

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
};

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
