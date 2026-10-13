/**
 * Boxes a running campaign holds (`api.campaigns.holds()`): a held box
 * outlives its lease while its budget covers it, wakes the campaign's lead
 * when the budget does not, and has its results copied off before it is
 * destroyed.
 *
 * - `CampaignWatch.round` runs on each enforce tick for a held box: it extends
 *   the lease when it ends within `EXTEND_WITHIN_MS` and the budget and the
 *   host's end date allow (the same limits `vast_extend` has: `extend.ts`),
 *   and wakes the lead once per lease end, `WAKE_BEFORE_MS` before it, when
 *   they do not.
 * - `pullSaves` copies the hold's remote globs to `~/lc-runs/<label>/` over
 *   the box's routes (rsync over ssh, direct first, then the proxy). The
 *   enforcer calls it before every destroy of a box held now or within the
 *   last `REMEMBER_MS` (`CampaignWatch.coverOf`), on top of `/root/.lease/save`.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hostCapOf, reachOf } from "./extend";
import { extend, type Lease, updateLeases } from "./leases";
import type { CampaignHold, ExtensionApi } from "./prifly-api";
import { parseLabel, span } from "./rules";
import { type Ran, type Route, run, runOverRoutes, sshRoutes } from "./run";
import { budgetText, cappedUntil, dollars, spentOf } from "./spend";
import type { Store } from "./store";
import type { Instance } from "./vast-api";

const HOUR_MS = 3_600_000;
/** A hold's lease is extended once it ends within this. */
export const EXTEND_WITHIN_MS = 2 * HOUR_MS;
/** Hours added by one campaign extension, as far as the budget and the host allow. */
export const EXTEND_HOURS = 8;
/** An extension shorter than this is not worth making: the budget is spent. */
const MIN_EXTEND_MS = 15 * 60_000;
/** The lead is woken this long before a lease that cannot be extended ends. */
export const WAKE_BEFORE_MS = 60 * 60_000;
/** A box whose hold ended is still covered this long. */
export const REMEMBER_MS = 24 * HOUR_MS;

/** What is copied off a box whose hold names no globs. */
export const DEFAULT_SAVE = [
  "/root/work/run/*/best.*",
  "/root/work/run/*/*.txt",
  "/root/work/run/*/*.log",
];

/** The last hold a box had, kept in the store so a box whose hold just ended is still covered. */
const HeldSchema = z.object({
  globs: z.array(z.string()),
  at: z.number(),
  label: z.string(),
});
type Held = z.infer<typeof HeldSchema>;
const HoldsFile = z.object({ holds: z.record(z.string(), HeldSchema) });

/** The globs a hold saves: its own, or the default when it names none. */
export function globsOf(hold: Pick<CampaignHold, "save">): string[] {
  return hold.save.length === 0 ? DEFAULT_SAVE : hold.save;
}

/** Where a box's results go: `~/lc-runs/<box label or id>/`. */
export function destOf(name: string, home: string = homedir()): string {
  return join(home, "lc-runs", name.replace(/^#/, "").replace(/[^A-Za-z0-9_.-]/g, "_") || "box");
}

/** What a destroy has to copy first, or nothing for a box no campaign held. */
export type Cover = { globs: string[]; dest: string };

type WatchApi = Pick<ExtensionApi, "campaigns" | "prompt" | "log">;

export class CampaignWatch {
  readonly #api: WatchApi;
  readonly #store: Store;
  /** Wakes already given, one per box and lease end. */
  readonly #woken = new Set<string>();

  constructor(api: WatchApi, store: Store) {
    this.#api = api;
    this.#store = store;
  }

  /** The holds now, by machine key; none where this prifly has no campaigns, or when they cannot be read. */
  holds(): Map<string, CampaignHold> {
    try {
      return new Map((this.#api.campaigns?.holds() ?? []).map((hold) => [hold.machineKey, hold]));
    } catch (caught) {
      this.#api.log("campaign_holds_failed", { message: messageOf(caught) });
      return new Map();
    }
  }

  /** Write down the globs and the time of every held box among `boxes`, so a destroy within a day of the hold ending still copies. */
  async track(
    boxes: readonly Instance[],
    holds: ReadonlyMap<string, CampaignHold>,
    now: number,
  ): Promise<void> {
    const held = boxes.flatMap((box) => {
      const hold = box.id === undefined ? undefined : holds.get(String(box.id));
      return box.id === undefined || hold === undefined
        ? []
        : [{ id: box.id, label: box.label ?? "", hold }];
    });
    if (held.length === 0) return;
    await this.#remember(held, now).catch((caught: unknown) =>
      this.#api.log("campaign_failed", { instance: null, message: messageOf(caught) }),
    );
  }

  /** Keep each entry for `REMEMBER_MS` after it was last written. */
  async #remember(
    held: readonly { id: number; label: string; hold: CampaignHold }[],
    now: number,
  ): Promise<void> {
    await this.#store.update("holds", (kept) => {
      const old = kept === undefined ? {} : HoldsFile.parse(kept).holds;
      const next: Record<string, Held> = {};
      for (const [key, entry] of Object.entries(old)) {
        if (now - entry.at <= REMEMBER_MS) next[key] = entry;
      }
      for (const { id, label, hold } of held) {
        next[String(id)] = { globs: globsOf(hold), at: now, label };
      }
      return { value: { holds: next }, result: null };
    });
  }

  /** What to copy off a box before destroying it: its hold's globs now, or the last hold's within a day; null when no campaign held it. */
  async coverOf(
    id: number,
    label: string,
    name: string,
    now: number,
    home?: string,
  ): Promise<Cover | null> {
    const hold = this.holds().get(String(id));
    if (hold !== undefined) return { globs: globsOf(hold), dest: destOf(name || label, home) };
    const kept = await this.#store.get("holds");
    const entry = kept === undefined ? undefined : HoldsFile.parse(kept).holds[String(id)];
    if (entry === undefined || now - entry.at > REMEMBER_MS) return null;
    return { globs: entry.globs, dest: destOf(name || entry.label, home) };
  }

  /**
   * One tick for a held box with a lease: extend it when it ends soon and the
   * budget allows, else wake the lead once when it ends within an hour.
   * Hands back the lease as it stands after.
   */
  async keep(box: Instance, id: number, lease: Lease, hold: CampaignHold, now: number) {
    try {
      return await this.#keep(box, id, lease, hold, now);
    } catch (caught) {
      this.#api.log("campaign_failed", { instance: id, message: messageOf(caught) });
      return lease;
    }
  }

  async #keep(box: Instance, id: number, lease: Lease, hold: CampaignHold, now: number) {
    let current = lease;
    if (lease.until - now <= EXTEND_WITHIN_MS) {
      const reach = reachOf(box, lease, EXTEND_HOURS, lease.budget, now);
      if (reach.end - reach.from >= MIN_EXTEND_MS) {
        current = await updateLeases(this.#store, (leases) =>
          extend(leases, { box: id }, reach.allowed, now),
        );
        this.#api.log("extended", {
          instance: id,
          until: current.until,
          budget: current.budget,
          by: "campaign",
        });
      }
    }
    await this.#wake(box, id, current, hold, now);
    return current;
  }

  /**
   * Before a destroy of a box a campaign holds, or held within the last day,
   * copy its hold's globs to `~/lc-runs/<box>/` (`pullSaves`): once more after
   * a failure, then the destroy goes on whatever came of it. Null when no
   * campaign held the box, or it is not running.
   */
  async pull(
    box: Instance,
    id: number,
    name: string,
    sshKey: string | null,
    how: {
      pull?: PullFn | undefined;
      sleep?: ((ms: number) => Promise<unknown>) | undefined;
      stopped: () => boolean;
    },
  ): Promise<Pulled | null> {
    const copy = how.pull ?? pullSaves;
    const sleep = how.sleep ?? Bun.sleep;
    try {
      const cover = await this.coverOf(id, box.label ?? "", name, Date.now());
      if (cover === null) return null;
      const routes = sshRoutes(box, sshKey);
      if (routes.length === 0) {
        this.#api.log("pull_skipped", { instance: id, reason: "the box is not running" });
        return null;
      }
      let last: Pulled | null = null;
      for (const attempt of [1, 2]) {
        if (attempt === 2) await sleep(PULL_RETRY_MS);
        last = await copy(routes, cover.globs, cover.dest).catch(
          (caught: unknown): Pulled => ({
            ok: false,
            files: 0,
            dest: cover.dest,
            error: messageOf(caught),
          }),
        );
        this.#api.log("pulled", {
          instance: id,
          attempt,
          ok: last.ok,
          files: last.files,
          dest: last.dest,
          error: last.error.slice(-200),
        });
        if (last.ok || how.stopped()) break;
      }
      return last;
    } catch (caught) {
      this.#api.log("campaign_failed", { instance: id, message: messageOf(caught) });
      return null;
    }
  }

  /** Tell the lead, once per lease end, that the box cannot be kept and what would be lost. */
  async #wake(box: Instance, id: number, lease: Lease, hold: CampaignHold, now: number) {
    const cap = hostCapOf(box);
    const ends = Math.min(
      cappedUntil(lease.until, box, lease.budget),
      cap ?? Number.POSITIVE_INFINITY,
    );
    if (ends - now > WAKE_BEFORE_MS) return;
    const key = `${id}:${ends}`;
    if (this.#woken.has(key)) return;
    this.#woken.add(key);
    const name = parseLabel(box.label ?? "")?.name ?? `#${id}`;
    const spent = spentOf(box, now);
    const why =
      cap !== null && ends >= cap
        ? "the host's end date"
        : lease.budget !== null && ends < lease.until
          ? `its budget of ${budgetText(lease.budget)}${spent === null ? "" : ` (spent ${dollars(spent)})`}`
          : "its lease, which the budget no longer covers extending";
    const text = `Campaign hold on ${name} (#${id}): ${hold.reason}. The box ends in ${span(ends - now)}, held by ${why}, and the budget does not allow more time. It is then saved and destroyed. Copied off first: ${globsOf(hold).join(", ")} into ${destOf(name)}; everything else on the box is lost. vast_extend asks the reader to raise the budget and keeps the box.`;
    try {
      await this.#api.prompt(hold.leadSession, text);
      this.#api.log("campaign_woke", { instance: id, lead: hold.leadSession.slice(0, 8), ends });
    } catch (caught) {
      // Not delivered: the next tick tries again.
      this.#woken.delete(key);
      this.#api.log("campaign_wake_failed", { instance: id, message: messageOf(caught) });
    }
  }
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** What copying the globs off a box came to. */
export type Pulled = { ok: boolean; files: number; dest: string; error: string };

/** `pullSaves`, or a test's stand-in. */
export type PullFn = (
  routes: readonly Route[],
  globs: readonly string[],
  dest: string,
) => Promise<Pulled>;

/** A pull that failed is tried once more after this, then the box is destroyed anyway. */
const PULL_RETRY_MS = 30_000;

/** What the destroy notice adds: that the box had no save script, and what the pull came to. */
export function destroyNote(hook: boolean | null, pulled: Pulled | null): string {
  const none = hook === false ? " It had no save script." : "";
  if (pulled === null) return none;
  return pulled.ok
    ? `${none} Copied ${pulled.files} file(s) to ${pulled.dest}.`
    : `${none} Copying its results to ${pulled.dest} failed (${pulled.error}).`;
}

/** What `pullSaves` reaches outside itself, so a test runs no ssh and writes nothing. */
export type PullDeps = {
  /** A shell command on the box, over its routes in order. */
  list: (routes: readonly Route[], command: string) => Promise<Ran>;
  /** A local program with its stdin. */
  spawn: (argv: string[], stdin: string) => Promise<Ran>;
  mkdir: (path: string) => Promise<unknown>;
};

const LIST_MS = 60_000;
const COPY_MS = 15 * 60_000;

export const realPull: PullDeps = {
  list: (routes, command) => runOverRoutes(routes, command, LIST_MS),
  spawn: (argv, stdin) => run(argv, COPY_MS, stdin),
  mkdir: (path) => mkdir(path, { recursive: true }),
};

/** A glob the extension will hand a remote shell: absolute, with no quote, space, `$`, `;` or backtick. */
const SAFE_GLOB = /^\/[A-Za-z0-9_.\-/*?[\]+@%=,~]+$/;

/** The directory a glob starts in, before its first wildcard segment: `/root/work/run` for `/root/work/run/*\/best.*`. */
export function baseOf(glob: string): string {
  const parts = glob.split("/");
  const fixed: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[]/.test(part)) break;
    fixed.push(part);
  }
  const base = fixed.join("/");
  return base === "" ? "/" : base;
}

/** The file names a listing printed, one per line. */
function linesOf(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Single-quote one argument for rsync's `-e`, which splits its string like a shell. */
function quoted(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The rsync argv for one route: its ssh argv minus the `root@host` it ends with, unattended. */
function rsyncArgv(route: Route, base: string, dest: string): string[] {
  const [ssh = "ssh", ...rest] = route.exec;
  const target = rest.pop() ?? "";
  const shell = [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...rest]
    .map(quoted)
    .join(" ");
  return ["rsync", "-a", "--files-from=-", "-e", shell, `${target}:${base}/`, `${dest}/`];
}

/**
 * Copy what `globs` match on the box into `dest`, keeping each file's path
 * below the glob's base (`run/lc1/best.pt` arrives as `dest/lc1/best.pt`).
 * Routes are tried in order, the next only when ssh could not connect. A glob
 * that matches nothing is not a failure; one the box could not be asked about,
 * or a copy that failed, is.
 */
export async function pullSaves(
  routes: readonly Route[],
  globs: readonly string[],
  dest: string,
  deps: PullDeps = realPull,
): Promise<Pulled> {
  let files = 0;
  const errors: string[] = [];
  try {
    await deps.mkdir(dest);
    for (const glob of globs) {
      if (!SAFE_GLOB.test(glob)) {
        errors.push(`not a plain absolute glob: ${glob}`);
        continue;
      }
      // The remote shell expands the glob; an unmatched one stays literal and `-f` drops it.
      const listed = await deps.list(
        routes,
        `for f in ${glob}; do [ -f "$f" ] && echo "$f"; done; true`,
      );
      if (listed.code !== 0) {
        errors.push(`listing ${glob} failed (${listed.code}): ${listed.err.trim().slice(-150)}`);
        continue;
      }
      const base = baseOf(glob);
      const names = linesOf(listed.out).flatMap((file) =>
        file.startsWith(`${base}/`) ? [file.slice(base.length + 1)] : [],
      );
      if (names.length === 0) continue;
      const copied = await copyOver(routes, deps, base, dest, names);
      if (copied === null) files += names.length;
      else errors.push(`copying ${glob} failed: ${copied}`);
    }
  } catch (caught) {
    errors.push(messageOf(caught));
  }
  return { ok: errors.length === 0, files, dest, error: errors.join("; ") };
}

/** rsync `names` (relative to `base`) over the routes in order; null when it worked, else why not. */
async function copyOver(
  routes: readonly Route[],
  deps: PullDeps,
  base: string,
  dest: string,
  names: readonly string[],
): Promise<string | null> {
  let last = "no ssh route to the box";
  for (const route of routes) {
    const ran = await deps.spawn(rsyncArgv(route, base, dest), names.join("\n"));
    if (ran.code === 0) return null;
    last = `rsync exit ${ran.code}: ${ran.err.trim().slice(-150)}`;
    if (ran.code !== 255) return last;
  }
  return last;
}
