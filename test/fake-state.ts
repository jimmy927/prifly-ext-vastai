/**
 * A fake `api.state` and `api.vault.ssh`, kept in memory, for the tests: the
 * contract prifly's `packages/extension-api/src/state.ts` and
 * `ExtensionVaultApi.ssh` describe, nothing real behind them.
 */

import type {
  ExtensionLogEntry,
  ExtensionStateApi,
  VaultSshOptions,
  VaultSshResult,
} from "../prifly-api";

/** A JSON copy, as prifly hands back: changing it changes nothing stored. */
const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export type FakeState = ExtensionStateApi & {
  docs: Map<string, unknown>;
  logs: Map<string, ExtensionLogEntry[]>;
  /** How many times each name's `importOnce` ran its `make`. */
  made: Map<string, number>;
};

/** `api.state` in memory: writes to one name run one at a time, in call order, as prifly's do. */
export function fakeState(): FakeState {
  const docs = new Map<string, unknown>();
  const logs = new Map<string, ExtensionLogEntry[]>();
  const made = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  let seq = 0;
  /** Run `job` after every write to `name` called before it. */
  const inLine = <T>(name: string, job: () => Promise<T>): Promise<T> => {
    const before = queues.get(name) ?? Promise.resolve();
    const run = before.then(job, job);
    queues.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };
  return {
    docs,
    logs,
    made,
    get: async (name) => copy(docs.get(name)) as never,
    set: (name, value) =>
      inLine(name, async () => {
        docs.set(name, copy(value));
      }),
    update: <T>(name: string, fn: (current: T | undefined) => T | Promise<T>) =>
      inLine(name, async () => {
        const next = await fn(copy(docs.get(name)) as T | undefined);
        if (next === undefined) throw new Error(`update of ${name} returned undefined`);
        docs.set(name, copy(next));
        return copy(next);
      }),
    delete: (name) => inLine(name, async () => docs.delete(name)),
    list: async () => [...docs.keys()].sort(),
    importOnce: <T>(name: string, make: () => T | undefined | Promise<T | undefined>) =>
      inLine(name, async () => {
        if (docs.has(name)) return copy(docs.get(name)) as T;
        made.set(name, (made.get(name) ?? 0) + 1);
        const value = await make();
        if (value !== undefined) docs.set(name, copy(value));
        return copy(value);
      }),
    append: async (name, entry) => {
      seq += 1;
      logs.set(name, [...(logs.get(name) ?? []), { seq, at: Date.now(), entry: copy(entry) }]);
      return seq;
    },
    read: async (name) => copy(logs.get(name) ?? []) as never,
  };
}

/** An `api.state` that cannot be read: prifly's database gone, every call throws. */
export function brokenState(): ExtensionStateApi {
  const fail = async (): Promise<never> => {
    throw new Error("database is locked");
  };
  return {
    get: fail,
    set: fail,
    update: fail,
    delete: fail,
    list: fail,
    importOnce: fail,
    append: fail,
    read: fail,
  };
}

export type VaultSshCall = { name: string; argv: string[]; options: VaultSshOptions | undefined };

/** `api.vault` with `ssh`: each call written down, answered with `answer`. */
export function fakeVault(answer: VaultSshResult) {
  const calls: VaultSshCall[] = [];
  return {
    calls,
    vault: {
      read: async () => null,
      ssh: async (name: string, argv: string[], options?: VaultSshOptions) => {
        calls.push({ name, argv, options });
        return answer;
      },
    },
  };
}
