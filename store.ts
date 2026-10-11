/**
 * Where the extension keeps what it remembers: the leases (`leases.ts`), the
 * endpoint claims (`endpoints.ts`), the charges cache (`charges.ts`) and the
 * boxes' history (`events.ts`).
 *
 * On a prifly whose `api.features` has "state", in prifly's database
 * (`api.state`), which moves with prifly's data to another host
 * (`prifly-move`); this folder, a git checkout, does not. The first time,
 * the files this extension kept before are brought in (`importOnce`), so a
 * running box keeps its lease; from then on they are left as they are and
 * never written. On an older prifly, the files in this folder, as before.
 *
 * Either way a document that cannot be read throws rather than reading as
 * empty: the enforcer must never take an unreadable store for "no leases" and
 * destroy every box as lease-less.
 */

import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionApi, ExtensionStateApi } from "./prifly-api";

const LOCK_WAIT_MS = 10_000;
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 30_000;

/** The documents: each a JSON value, written whole. */
export type DocName = "leases" | "endpoints" | "charges";
/** The logs: append-only, read back whole. */
export type LogName = "events";

export type Store = {
  /** "files" or "state", for the log. */
  readonly kind: "files" | "state";
  /** The document, or undefined when there is none; a throw when it cannot be read. */
  get(name: DocName): Promise<unknown>;
  /** Replace the document, in one write. */
  set(name: DocName, value: unknown): Promise<void>;
  /**
   * Read, change and write the document, one change at a time: two at once
   * never lose each other's. `change` returns what to keep and what to hand
   * back to the caller.
   */
  update<T>(name: DocName, change: (current: unknown) => { value: unknown; result: T }): Promise<T>;
  append(name: LogName, entries: readonly unknown[]): Promise<void>;
  /** The log's entries, in the order they were appended; one that does not parse is skipped. */
  read(name: LogName): Promise<unknown[]>;
  /**
   * Start the log once, when it has never been kept, from `seed`; how many
   * entries it got. A later start gets 0 and leaves it alone.
   */
  seed(name: LogName, seed: () => Promise<unknown[]>): Promise<number>;
};

/** The store this prifly has, logged: `api.state` where it says "state", else the files in `api.folder`. */
export function storeFor(
  api: Pick<ExtensionApi, "features" | "state" | "folder">,
  log: ExtensionApi["log"],
): Store {
  const state = api.features?.includes("state") ? api.state : undefined;
  const store =
    state === undefined ? fileStore(api.folder) : new StateStore(state, api.folder, log);
  log("store", { kind: store.kind });
  return store;
}

/** Where each is kept as a file. */
export function filePath(folder: string, name: DocName | LogName): string {
  return join(folder, name === "events" ? "events.jsonl" : `${name}.json`);
}

/** Each line of a JSON-lines text that parses; a line cut short by a crash is skipped. */
export function jsonLines(text: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash: the rest of the file still counts.
    }
  }
  return entries;
}

/** A file's JSON, or undefined when there is no file; a throw when it does not parse. */
async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.json() : undefined;
}

/**
 * Make the lock file: "made", or "held" when it exists. On Windows an EPERM
 * comes back as itself: Windows says that while the last holder's file is
 * still being deleted. Any other error is thrown.
 */
async function create(path: string): Promise<"made" | "held" | Error> {
  try {
    const handle = await open(path, "wx");
    await handle.close();
    return "made";
  } catch (caught) {
    const code = caught instanceof Error && "code" in caught ? caught.code : null;
    if (code === "EEXIST") return "held";
    if (process.platform === "win32" && code === "EPERM") return caught as Error;
    throw caught;
  }
}

/** Hold `path` as a lock file; the function given back lets go. */
export async function lock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const made = await create(path);
    if (made === "made") return () => rm(path, { force: true });
    const held = await stat(path).catch(() => null);
    if (held !== null && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      // An EPERM that never cleared was a real refusal: its own error, not "locked".
      if (made instanceof Error) throw made;
      throw new Error(`The file is locked: ${path}`);
    }
    await Bun.sleep(50);
  }
}

/**
 * The files in the extension's folder, as before prifly had `api.state`. A
 * document is written whole with a rename, under a lock file beside it,
 * since the tools and the enforcer both write it.
 */
export function fileStore(folder: string): Store {
  const path = (name: DocName | LogName) => filePath(folder, name);
  const write = async (file: string, value: unknown) => {
    const temp = `${file}.${process.pid}.tmp`;
    await Bun.write(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
  };
  return {
    kind: "files",
    get: (name) => readJson(path(name)),
    // The charges cache, the only document `set`, is written as it always was: plain, no lock.
    set: async (name, value) => {
      await Bun.write(path(name), `${JSON.stringify(value)}\n`);
    },
    update: async (name, change) => {
      const file = path(name);
      const release = await lock(`${file}.lock`);
      try {
        const { value, result } = change(await readJson(file));
        await write(file, value);
        return result;
      } finally {
        await release();
      }
    },
    append: async (name, entries) => {
      if (entries.length === 0) return;
      await appendFile(path(name), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    },
    read: async (name) => {
      const file = Bun.file(path(name));
      return (await file.exists()) ? jsonLines(await file.text()) : [];
    },
    seed: async (name, seed) => {
      if (await Bun.file(path(name)).exists()) return 0;
      const entries = await seed();
      // Written even when empty, so the seed is read once.
      await Bun.write(path(name), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      return entries.length;
    },
  };
}

/**
 * prifly's database (`api.state`). Before a document is first used in a run,
 * the file it was kept in is brought in once (`importOnce`): until that
 * succeeds every use of the document throws, so nothing reads it as empty.
 * After it, the file is never read again, nor written.
 */
export class StateStore implements Store {
  readonly kind = "state";
  readonly #state: ExtensionStateApi;
  readonly #folder: string;
  readonly #log: ExtensionApi["log"];
  /** Documents brought in, or checked, this run. */
  readonly #imported = new Map<DocName, Promise<void>>();

  constructor(state: ExtensionStateApi, folder: string, log: ExtensionApi["log"]) {
    this.#state = state;
    this.#folder = folder;
    this.#log = log;
  }

  async get(name: DocName): Promise<unknown> {
    await this.#ready(name);
    return this.#state.get(name);
  }

  async set(name: DocName, value: unknown): Promise<void> {
    await this.#ready(name);
    await this.#state.set(name, value);
  }

  async update<T>(
    name: DocName,
    change: (current: unknown) => { value: unknown; result: T },
  ): Promise<T> {
    await this.#ready(name);
    let result: { value: T } | null = null;
    // `api.state.update` runs the writes to one name one at a time, in call order.
    await this.#state.update<unknown>(name, (current) => {
      const changed = change(current);
      result = { value: changed.result };
      return changed.value;
    });
    if (result === null) throw new Error(`The ${name} update did not run`);
    return (result as { value: T }).value;
  }

  async append(name: LogName, entries: readonly unknown[]): Promise<void> {
    for (const entry of entries) await this.#state.append(name, entry);
  }

  async read(name: LogName): Promise<unknown[]> {
    return (await this.#state.read(name)).map((row) => row.entry);
  }

  /**
   * The log's file, or `seed` when there is none, brought in once: a marker
   * document, `<name>.imported`, says it was. An import cut short is finished
   * by the next start, without adding what it already added.
   */
  async seed(name: LogName, seed: () => Promise<unknown[]>): Promise<number> {
    let added = 0;
    await this.#state.importOnce(`${name}.imported`, async () => {
      const file = Bun.file(filePath(this.#folder, name));
      const entries = (await file.exists()) ? jsonLines(await file.text()) : await seed();
      const kept = new Set((await this.read(name)).map((entry) => JSON.stringify(entry)));
      for (const entry of entries) {
        if (kept.has(JSON.stringify(entry))) continue;
        await this.#state.append(name, entry);
        added += 1;
      }
      this.#log("state_imported", { name, entries: entries.length, added });
      return { at: Date.now(), entries: entries.length };
    });
    return added;
  }

  /** Bring the document's file in, once a run; a failure throws now and is tried again next use. */
  #ready(name: DocName): Promise<void> {
    const known = this.#imported.get(name);
    if (known !== undefined) return known;
    const importing = this.#state
      .importOnce(name, async () => {
        const old = await readJson(filePath(this.#folder, name));
        if (old !== undefined) this.#log("state_imported", { name });
        return old;
      })
      .then(() => undefined)
      .catch((caught: unknown) => {
        this.#imported.delete(name);
        this.#log("state_import_failed", {
          name,
          message: caught instanceof Error ? caught.message : String(caught),
        });
        throw caught;
      });
    this.#imported.set(name, importing);
    return importing;
  }
}
