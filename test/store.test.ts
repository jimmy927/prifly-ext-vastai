import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChargeCache } from "../charges";
import { claimEndpoint, readClaims } from "../endpoints";
import { Enforcer } from "../enforce";
import { appendEvents, readEvents, seedFromHostLog } from "../events";
import { book, type Lease, readLeases, updateLeases } from "../leases";
import type { ExtensionApi } from "../prifly-api";
import { filePath, fileStore, StateStore, storeFor } from "../store";
import type { Instance } from "../vast-api";
import { brokenState, fakeState } from "./fake-state";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const SESSION = "0123abcd-1111-2222-3333-444455556666";
const LABEL = "jimmy/s-0123abcd/lc-box1";

const lease: Lease = {
  label: LABEL,
  box: 7,
  bookedAt: NOW - H,
  until: NOW + 5 * H,
  cancelled: false,
  budget: 10,
};

const folder = () => mkdtemp(join(tmpdir(), "vast-store-"));

/** A folder holding what an older version of the extension kept there: a lease, a claim, a day's charges and two events. */
async function oldFiles(): Promise<string> {
  const dir = await folder();
  await Bun.write(filePath(dir, "leases"), JSON.stringify({ leases: [lease] }));
  await Bun.write(
    filePath(dir, "endpoints"),
    JSON.stringify({
      endpoints: [{ endpoint: 39180, name: "rj-judge", session: SESSION, at: NOW }],
    }),
  );
  await Bun.write(
    filePath(dir, "charges"),
    JSON.stringify({
      days: {
        "2026-10-01": { at: NOW, rows: [{ box: 7, label: LABEL, kind: "instance", amount: 2 }] },
      },
    }),
  );
  await Bun.write(
    filePath(dir, "events"),
    `${JSON.stringify({ at: NOW - H, kind: "rented", box: 7, label: LABEL })}\n${JSON.stringify({ at: NOW - H + 1, kind: "appeared", box: 7, label: LABEL })}\n`,
  );
  return dir;
}

/** Every old file's bytes, to see that none was written. */
async function snapshot(dir: string): Promise<string[]> {
  return Promise.all(
    (["leases", "endpoints", "charges", "events"] as const).map((name) =>
      readFile(filePath(dir, name), "utf8"),
    ),
  );
}

const log = () => undefined;

describe("storeFor", () => {
  test('prifly\'s database only where api.features says "state"', async () => {
    const dir = await folder();
    const state = fakeState();
    expect(storeFor({ folder: dir, state }, log).kind).toBe("files");
    expect(storeFor({ folder: dir, features: ["vault-ssh"], state }, log).kind).toBe("files");
    expect(storeFor({ folder: dir, features: ["state"] }, log).kind).toBe("files");
    expect(storeFor({ folder: dir, features: ["state"], state }, log).kind).toBe("state");
  });

  test('without "state", the files are read and written as before', async () => {
    const dir = await oldFiles();
    const store = storeFor({ folder: dir, features: [] }, log);
    expect(await readLeases(store)).toEqual([lease]);
    await updateLeases(store, (leases) => book(leases, "jimmy/s-0123abcd/b2", 1, NOW));
    const written = JSON.parse(await readFile(filePath(dir, "leases"), "utf8"));
    expect(written.leases).toHaveLength(2);
  });
});

describe("the import from the files", () => {
  test("brings every file in once, and never writes them again", async () => {
    const dir = await oldFiles();
    const before = await snapshot(dir);
    const state = fakeState();
    const store = new StateStore(state, dir, log);
    expect(await seedFromHostLog(store, join(dir, "logs"), "vastai")).toBe(2);
    // The running box keeps its lease.
    expect(await readLeases(store)).toEqual([lease]);
    expect((await readClaims(store)).map((c) => c.endpoint)).toEqual([39180]);
    expect((await readEvents(store)).map((e) => e.kind)).toEqual(["rented", "appeared"]);
    // Changes go to the database only.
    await updateLeases(store, (leases) => book(leases, "jimmy/s-0123abcd/b2", 1, NOW));
    await claimEndpoint(store, { endpoint: 38596, name: "rj-rerank", session: SESSION, at: NOW });
    await appendEvents(store, [{ at: NOW, kind: "gone", box: 7 }]);
    const cache = new ChargeCache(store, async () => [
      { box: 8, label: "x", kind: "instance", amount: 1 },
    ]);
    const { rows } = await cache.days(["2026-10-01", "2026-10-06"], NOW);
    expect(rows.get("2026-10-01")?.[0]?.amount).toBe(2);
    expect(await snapshot(dir)).toEqual(before);
    expect((state.docs.get("leases") as { leases: Lease[] }).leases).toHaveLength(2);
    expect(state.logs.get("events")).toHaveLength(3);
  });

  test("a second start reads the database, not the files again", async () => {
    const dir = await oldFiles();
    const state = fakeState();
    const first = new StateStore(state, dir, log);
    await seedFromHostLog(first, join(dir, "logs"), "vastai");
    await updateLeases(first, () => ({ leases: [], result: null }));
    // The old file is still there, still holding the lease; the next start must not bring it back.
    const second = new StateStore(state, dir, log);
    expect(await seedFromHostLog(second, join(dir, "logs"), "vastai")).toBe(0);
    expect(await readLeases(second)).toEqual([]);
    expect(state.logs.get("events")).toHaveLength(2);
    expect(state.made.get("leases")).toBe(1);
    expect(state.made.get("events.imported")).toBe(1);
  });

  test("no file: nothing is stored, and the history is seeded from the host's log", async () => {
    const dir = await folder();
    await Bun.write(
      join(dir, "logs", "prifly.log"),
      `{"at":"2026-10-05T07:04:31.988Z","event":"ext.vastai.destroyed","instance":54,"reason":"cancelled"}\n`,
    );
    const state = fakeState();
    const store = new StateStore(state, dir, log);
    expect(await seedFromHostLog(store, join(dir, "logs"), "vastai")).toBe(1);
    expect(await readLeases(store)).toEqual([]);
    expect(state.docs.has("leases")).toBe(false);
  });

  test("an import cut short is finished without doubling what it already brought", async () => {
    const dir = await oldFiles();
    const state = fakeState();
    // The first event got in before the process died, the marker did not.
    await state.append("events", { at: NOW - H, kind: "rented", box: 7, label: LABEL });
    const store = new StateStore(state, dir, log);
    expect(await seedFromHostLog(store, join(dir, "logs"), "vastai")).toBe(1);
    expect((await readEvents(store)).map((e) => e.kind)).toEqual(["rented", "appeared"]);
  });

  test("an import that fails throws, and is tried again on the next use", async () => {
    const dir = await oldFiles();
    const state = fakeState();
    const real = state.importOnce;
    let failures = 1;
    state.importOnce = (name, make) => {
      if (failures-- > 0) return Promise.reject(new Error("busy"));
      return real(name, make);
    };
    const store = new StateStore(state, dir, log);
    await expect(readLeases(store)).rejects.toThrow("busy");
    expect(await readLeases(store)).toEqual([lease]);
  });
});

test("two updates at once both land: the store goes through api.state.update", async () => {
  const state = fakeState();
  // A slow read: an update made of a get and a set would lose all but one.
  const get = state.get;
  state.get = (async (name: string) => {
    await Bun.sleep(5);
    return get(name);
  }) as typeof get;
  const store = new StateStore(state, await folder(), log);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      updateLeases(store, (leases) => book(leases, `jimmy/s-0123abcd/b${i}`, 1, NOW)),
    ),
  );
  expect(await readLeases(store)).toHaveLength(10);
});

test("the file store's lock keeps two updates at once too", async () => {
  const store = fileStore(await folder());
  await Promise.all([
    updateLeases(store, (leases) => book(leases, "jimmy/s-0123abcd/a", 1, NOW)),
    updateLeases(store, (leases) => book(leases, "jimmy/s-0123abcd/b", 1, NOW)),
  ]);
  expect((await readLeases(store)).map((l) => l.label).sort()).toEqual([
    "jimmy/s-0123abcd/a",
    "jimmy/s-0123abcd/b",
  ]);
});

describe("an unreadable store never makes a box lease-less", () => {
  const box: Instance = {
    id: 7,
    label: LABEL,
    actual_status: "exited",
    start_date: (NOW - 2 * H) / 1000,
  };

  async function enforcerOn(store: StateStore, dir: string) {
    const destroyed: number[] = [];
    const notices: string[] = [];
    const api = {
      folder: dir,
      log: () => undefined,
      notify: (text: string) => notices.push(text),
      sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
    } as unknown as ExtensionApi;
    const enforcer = new Enforcer(
      api,
      store,
      { sshKey: null, enforce: true, owner: "jimmy" },
      {
        destroy: async (id) => {
          destroyed.push(id);
        },
      },
    );
    return { enforcer, destroyed, notices };
  }

  test("prifly's database failing: the round fails, nothing is destroyed or said", async () => {
    const dir = await folder();
    const { enforcer, destroyed, notices } = await enforcerOn(
      new StateStore(brokenState(), dir, log),
      dir,
    );
    await expect(enforcer.round([box], NOW)).rejects.toThrow("database is locked");
    await Bun.sleep(30);
    expect(destroyed).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("a leases.json that does not parse: not imported as none, the round fails", async () => {
    const dir = await folder();
    await Bun.write(filePath(dir, "leases"), '{"leases": [');
    const state = fakeState();
    const { enforcer, destroyed } = await enforcerOn(new StateStore(state, dir, log), dir);
    await expect(enforcer.round([box], NOW)).rejects.toThrow();
    await Bun.sleep(30);
    expect(destroyed).toEqual([]);
    expect(state.docs.has("leases")).toBe(false);
  });

  test("once imported, the box's lease holds it", async () => {
    const dir = await oldFiles();
    const { enforcer, destroyed } = await enforcerOn(new StateStore(fakeState(), dir, log), dir);
    const judged = await enforcer.round([box], NOW);
    expect(judged.get(7)?.verdict.kind).toBe("leased");
    expect(destroyed).toEqual([]);
  });
});
