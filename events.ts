/**
 * The history of every box: what the spend panel's timeline is drawn from.
 *
 * The leases hold only those running now — a lease is dropped when its box
 * goes — so the past is kept here, in the store's "events" log (`store.ts`:
 * prifly's `api.state`, or `events.jsonl` in the extension's folder on an
 * older prifly): one JSON entry per event, only ever appended to.
 *
 * Two kinds of event land here:
 * - What the extension does, recorded where it already logs it (`recorder`
 *   wraps `api.log`): a box rented (with its budget, lease end and rate),
 *   replaced, extended, cancelled, found broken or destroyed.
 * - What the list of boxes shows each minute (`observe`): a box seen for the
 *   first time (with its start and rate), and a box no longer listed —
 *   destroyed from the console, by its on-box guard, or by Vast.ai — so every
 *   box has an end, whoever ended it.
 *
 * The first time there is no history, the lines the host's log still holds
 * (`prifly*.log`, about two days) are read in, so the timeline is not empty
 * on the day this ships.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ExtensionApi } from "./prifly-api";
import type { Store } from "./store";
import type { Instance } from "./vast-api";

export const EventSchema = z.object({
  /** Epoch ms. */
  at: z.number(),
  kind: z.enum(["rented", "extended", "cancelled", "broken", "destroyed", "appeared", "gone"]),
  box: z.number(),
  label: z.string().optional(),
  /** Dollars the reader confirmed. */
  budget: z.number().optional(),
  /** The lease's end after this event, epoch ms. */
  until: z.number().optional(),
  /** Dollars an hour. */
  rate: z.number().optional(),
  /** When the box started, epoch ms (an `appeared` event). */
  start: z.number().optional(),
  /** Why it was destroyed or found broken. */
  reason: z.string().optional(),
  /** Who extended or destroyed it: "session" or "reader". */
  by: z.string().optional(),
});
export type BoxEvent = z.infer<typeof EventSchema>;

/** Every event, oldest first; one that does not parse is skipped. */
export async function readEvents(store: Store): Promise<BoxEvent[]> {
  const events: BoxEvent[] = [];
  for (const entry of await store.read("events")) {
    const parsed = EventSchema.safeParse(entry);
    if (parsed.success) events.push(parsed.data);
  }
  return events.sort((a, b) => a.at - b.at);
}

export function appendEvents(store: Store, events: readonly BoxEvent[]): Promise<void> {
  return store.append("events", events);
}

type Fields = Parameters<ExtensionApi["log"]>[1];

/**
 * The event a log line stands for, or null when it is not one. `at` is when
 * it is said; the host's own log lines carry theirs.
 */
export function eventOfLog(name: string, fields: Fields, at: number): BoxEvent | null {
  const f = fields ?? {};
  const num = (key: string) => (typeof f[key] === "number" ? (f[key] as number) : undefined);
  const str = (key: string) => (typeof f[key] === "string" ? (f[key] as string) : undefined);
  const box = num("instance") ?? Number(str("instance") ?? Number.NaN);
  if (!Number.isFinite(box)) return null;
  const kind = KINDS[name];
  if (kind === undefined) return null;
  const event: BoxEvent = { at, kind, box };
  const label = str("label");
  const budget = num("budget");
  const until = num("until");
  const rate = num("rate");
  const reason = str("reason");
  const by = str("by");
  if (label !== undefined) event.label = label;
  if (budget !== undefined) event.budget = budget;
  if (until !== undefined) event.until = Math.round(until);
  if (rate !== undefined) event.rate = rate;
  if (reason !== undefined) event.reason = reason;
  if (by !== undefined) event.by = by;
  return event;
}

const KINDS: Record<string, BoxEvent["kind"]> = {
  rented: "rented",
  replacement_rented: "rented",
  extended: "extended",
  cancelled: "cancelled",
  broken: "broken",
  destroyed: "destroyed",
};

/**
 * `api.log`, also writing the history: every log line that is an event is
 * appended to the history as well. A write that fails is logged and lost;
 * it never fails what was being done.
 */
export function recorder(
  store: Store,
  log: ExtensionApi["log"],
  now: () => number = Date.now,
): ExtensionApi["log"] {
  return (name, fields) => {
    log(name, fields);
    const event = eventOfLog(name, fields, now());
    if (event === null) return;
    appendEvents(store, [event]).catch((caught: unknown) =>
      log("history_write_failed", {
        message: caught instanceof Error ? caught.message : String(caught),
      }),
    );
  };
}

/** `api` with its `log` writing the history too, for the enforcer, which logs through `api`. */
export function withRecorder(api: ExtensionApi, log: ExtensionApi["log"]): ExtensionApi {
  return new Proxy(api, {
    get: (target, key) => (key === "log" ? log : Reflect.get(target, key, target)),
  });
}

/**
 * Seeing the list of boxes each minute: the boxes not yet known appear, the
 * known ones no longer listed are gone. Which boxes are live is read back
 * from the history at the start, so a restart neither repeats nor misses one.
 */
export class Observer {
  readonly #store: Store;
  #live: Set<number> | null = null;

  constructor(store: Store) {
    this.#store = store;
  }

  /** The events this list adds, written to the history. */
  async observe(boxes: readonly Instance[], now: number): Promise<BoxEvent[]> {
    const live = this.#live ?? liveOf(await readEvents(this.#store));
    const listed = new Set<number>();
    const added: BoxEvent[] = [];
    for (const box of boxes) {
      if (box.id === undefined) continue;
      listed.add(box.id);
      if (live.has(box.id)) continue;
      const event: BoxEvent = { at: now, kind: "appeared", box: box.id, label: box.label ?? "" };
      if (box.start_date !== undefined) event.start = box.start_date * 1000;
      if (box.dph_total !== undefined) event.rate = box.dph_total;
      added.push(event);
    }
    for (const id of live) if (!listed.has(id)) added.push({ at: now, kind: "gone", box: id });
    await appendEvents(this.#store, added);
    this.#live = listed;
    return added;
  }
}

/** The boxes that appeared and are not gone yet. */
export function liveOf(events: readonly BoxEvent[]): Set<number> {
  const live = new Set<number>();
  for (const event of events) {
    if (event.kind === "appeared") live.add(event.box);
    if (event.kind === "gone") live.delete(event.box);
  }
  return live;
}

/** prifly's own log folder, beside `extensions/`: `~/.local/share/prifly/logs`. */
export function hostLogFolder(extensionFolder: string): string {
  return resolve(extensionFolder, "..", "..", "logs");
}

/**
 * Start the history from what the host's log still holds, when there is no
 * history yet (`Store.seed`: on a prifly with `api.state`, an `events.jsonl`
 * kept before is brought in instead, once). The host's lines are
 * `{"at": ISO, "event": "ext.vastai.<name>", …}`.
 */
export function seedFromHostLog(
  store: Store,
  logFolder: string,
  extensionId: string,
): Promise<number> {
  return store.seed("events", async () => {
    const names = await readdir(logFolder).catch(() => [] as string[]);
    const prefix = `ext.${extensionId}.`;
    const events: BoxEvent[] = [];
    for (const name of names.filter((n) => /^prifly(\.\d+)?\.log$/.test(n))) {
      const text = await Bun.file(join(logFolder, name))
        .text()
        .catch(() => "");
      for (const line of text.split("\n")) {
        if (!line.includes(`"${prefix}`)) continue;
        const event = hostLine(line, prefix);
        if (event !== null) events.push(event);
      }
    }
    return events.sort((a, b) => a.at - b.at);
  });
}

function hostLine(line: string, prefix: string): BoxEvent | null {
  try {
    const { at, event, ...fields } = JSON.parse(line) as Record<string, unknown>;
    if (typeof event !== "string" || !event.startsWith(prefix) || typeof at !== "string") {
      return null;
    }
    return eventOfLog(event.slice(prefix.length), fields as Fields, Date.parse(at));
  } catch {
    return null;
  }
}
