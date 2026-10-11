/**
 * What the panel (`panel/`) asks for: `api/boxes` (every box as a card,
 * `fleet.ts`), `POST api/action` (a card's button) and `api/data?days=<n>`.
 *
 * One answer holds all three charts' data, and the page sums it by day or
 * week, by session or repository, itself:
 * - `charges`: what each box cost on each UTC day (`charges.ts`), with the
 *   group its label puts it in;
 * - `groups`: each group's title and repository — a session of this prifly
 *   (by the `s-<session8>` in the label, found among the host's sessions), a
 *   repository named in a `project-<repo>/` label, another owner's boxes, or
 *   none;
 * - `boxes`: the timeline (`timeline.ts`), from the history;
 * - `live`: what bills now.
 */

import { basename } from "node:path";
import { type ChargeCache, type ChargeRow, dayStart, lastDays } from "./charges";
import { type BoxEvent, readEvents } from "./events";
import type { BoxCard } from "./fleet";
import { type Lease, readLeases } from "./leases";
import type { ExtensionSession, PanelRequest } from "./prifly-api";
import { repoOfFolder } from "./repo";
import { parseLabel } from "./rules";
import type { Store } from "./store";
import { type TimelineBox, timelineOf } from "./timeline";
import type { Instance } from "./vast-api";

export type GroupKind = "session" | "gone" | "repo" | "foreign" | "none";

export type Group = {
  title: string;
  repo: string;
  kind: GroupKind;
  /** The session's first 8 characters, for a session's group. */
  session: string | null;
};

export type PanelDeps = {
  /** Where the history and the leases are kept (`store.ts`). */
  store: Store;
  owner: string;
  sessions: () => ExtensionSession[];
  charges: ChargeCache;
  /** The boxes the last refresh listed. */
  listed: () => readonly Instance[];
  now: () => number;
  /** Every box as the panel's card. */
  cards: () => BoxCard[];
  /** A card's button: the same actions as the box's menu. */
  act: (key: string, action: string) => Promise<string>;
  /** ssh to a running box, for a card's "Open shell"; null when it has none. */
  terminal: (key: string) => { title: string; command: string[] } | null;
  /** What this prifly can do: "panel-open-session" and "panel-open-terminal" let a card open its session and a shell. */
  features: readonly string[];
};

/** The card buttons a request may press: the box menu's own action ids. */
const CARD_ACTIONS = new Set(["extend1", "extend4", "destroy"]);

/** The days a request may ask for, at most. */
export const MAX_DAYS = 120;
const DEFAULT_DAYS = 30;
export const NONE = "none";

/** The group a label puts a box in, and that group's key. */
export function groupKeyOf(label: string, owner: string): string {
  const parsed = parseLabel(label);
  if (parsed !== null) {
    if (parsed.owner !== null && parsed.owner !== owner) return `owner:${parsed.owner}`;
    return `s:${parsed.session}`;
  }
  const repo = /^project-([a-z0-9._-]+)\//i.exec(label)?.[1];
  return repo === undefined ? NONE : `repo:${repo}`;
}

/** The name a box goes by: its label's name part, else its label, else its id. */
export function nameOfBox(label: string, box: number | null): string {
  const parsed = parseLabel(label);
  if (parsed !== null) return parsed.name;
  const slash = label.lastIndexOf("/");
  if (label !== "") return slash < 0 ? label : label.slice(slash + 1);
  return box === null ? "?" : `#${box}`;
}

function groupOf(
  key: string,
  sessions: readonly ExtensionSession[],
  repoOf: (cwd: string) => string,
): Group {
  const [kind, rest = ""] = key.split(/:(.*)/);
  if (kind === "s") {
    const session = sessions.find((s) => s.id.startsWith(rest));
    return session === undefined
      ? {
          title: `Session ${rest} (no longer in prifly)`,
          repo: "(unknown repository)",
          kind: "gone",
          session: rest,
        }
      : { title: session.title || rest, repo: repoOf(session.cwd), kind: "session", session: rest };
  }
  if (kind === "owner") {
    return { title: `${rest}'s prifly`, repo: `${rest}'s prifly`, kind: "foreign", session: null };
  }
  if (kind === "repo") {
    return {
      title: `Labelled project-${rest}, no session`,
      repo: rest,
      kind: "repo",
      session: null,
    };
  }
  return { title: "No session label", repo: "No session label", kind: "none", session: null };
}

/** Each group key's title and repository, the sessions found by the start of their id. */
export function describeGroups(
  keys: Iterable<string>,
  sessions: readonly ExtensionSession[],
  repoOf: (cwd: string) => string = repoOfFolder,
): Record<string, Group> {
  const groups: Record<string, Group> = {};
  const known = new Set<string>();
  for (const key of keys) {
    const group = groupOf(key, sessions, repoOf);
    groups[key] = group;
    if (group.kind === "session") known.add(group.repo);
  }
  // `project-odi` is the `artemisrec/odi` a session's folder names, when one does.
  for (const group of Object.values(groups)) {
    if (group.kind !== "repo") continue;
    const full = [...known].find((repo) => basename(repo) === group.repo);
    if (full !== undefined) group.repo = full;
  }
  return groups;
}

export type ChargeLine = {
  day: string;
  group: string;
  box: number | null;
  name: string;
  amount: number;
};

/** The days' charge rows, each with its group and box name; rows of no money are left out. */
export function chargeLines(
  rows: ReadonlyMap<string, readonly ChargeRow[]>,
  owner: string,
): ChargeLine[] {
  const lines: ChargeLine[] = [];
  for (const [day, dayRows] of rows) {
    for (const row of dayRows) {
      if (row.amount === 0) continue;
      lines.push({
        day,
        group: groupKeyOf(row.label, owner),
        box: row.box,
        name: nameOfBox(row.label, row.box),
        amount: row.amount,
      });
    }
  }
  return lines;
}

export type PanelData = {
  now: number;
  days: string[];
  failed: string[];
  charges: ChargeLine[];
  groups: Record<string, Group>;
  boxes: (TimelineBox & { group: string; name: string })[];
  /** When the history starts: the timeline knows nothing before it. */
  historyFrom: number | null;
  live: { burn: number; names: string[] };
};

export async function panelData(deps: PanelDeps, days: number): Promise<PanelData> {
  const now = deps.now();
  const wanted = lastDays(days, now);
  const from = dayStart(wanted[0] ?? "");
  const [{ rows, failed }, events, leases] = await Promise.all([
    deps.charges.days(wanted, now),
    readEvents(deps.store),
    readLeases(deps.store).catch(() => [] as Lease[]),
  ]);
  const listed = deps.listed();
  const charges = chargeLines(rows, deps.owner);
  // A box whose label the history never heard (its rent rotated out of the host's log) has it in its charges.
  const charged = new Map<number, string>();
  for (const dayRows of rows.values()) {
    for (const row of dayRows) if (row.box !== null && row.label) charged.set(row.box, row.label);
  }
  const boxes = timelineOf(events, listed, leases, from, now).map((box) => {
    const label = box.label || charged.get(box.box) || "";
    return {
      ...box,
      label,
      group: groupKeyOf(label, deps.owner),
      name: nameOfBox(label, box.box),
    };
  });
  const keys = new Set([...charges.map((c) => c.group), ...boxes.map((b) => b.group)]);
  const running = listed.filter((box) => (box.actual_status ?? box.intended_status) === "running");
  return {
    now,
    days: wanted,
    failed,
    charges,
    groups: describeGroups(keys, deps.sessions()),
    boxes,
    historyFrom: firstAt(events),
    live: {
      burn: listed.reduce((sum, box) => sum + (box.dph_total ?? 0), 0),
      names: running.map((box) => nameOfBox(box.label ?? "", box.id ?? null)),
    },
  };
}

function firstAt(events: readonly BoxEvent[]): number | null {
  return events.length === 0 ? null : Math.min(...events.map((e) => e.at));
}

/** The panel's requests. */
export async function answer(deps: PanelDeps, request: PanelRequest): Promise<unknown> {
  if (request.path === "boxes") {
    return {
      now: deps.now(),
      boxes: deps.cards(),
      openSession: deps.features.includes("panel-open-session"),
      openShell: deps.features.includes("panel-open-terminal"),
    };
  }
  if (request.path === "action") {
    const { key, action } = (request.body ?? {}) as { key?: unknown; action?: unknown };
    if (typeof key !== "string" || typeof action !== "string" || !CARD_ACTIONS.has(action)) {
      throw new Error("A card's action needs a box key and one of extend1, extend4, destroy.");
    }
    return { message: await deps.act(key, action) };
  }
  if (request.path !== "data") throw new Error(`No such request: ${request.path}`);
  const asked = Number(request.query["days"] ?? DEFAULT_DAYS);
  const days = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_DAYS) : DEFAULT_DAYS;
  return panelData(deps, days);
}
