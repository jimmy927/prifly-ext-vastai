import { describe, expect, test } from "bun:test";
import { type EnforceDeps, Enforcer } from "../enforce";
import { leasesPath, readLeases } from "../leases";
import type { ExtensionApi } from "../prifly-api";
import type { Instance } from "../vast-api";
import { ctxFor, H, LABEL, NOW, type Offer, offer, SESSION, setup, vast } from "./fake-vast";

const MIN = 60_000;
const RENT = {
  name: "job1",
  budget: 20,
  offers: [101, 102, 103, 104, 105],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "a job",
};

/** A card of five offers, each on a machine of its own, except 102, which shares 101's. */
const machineOf = (id: number) => ({ 101: 1, 102: 1, 103: 3, 104: 4, 105: 5 })[id] ?? 0;
const card = (): Offer[] =>
  [101, 102, 103, 104, 105].map((id) => offer(id, 0.5, { machine_id: machineOf(id) }));

type Stage = {
  folder: string;
  fake: ReturnType<typeof vast>;
  offers: Offer[];
  tool: Awaited<ReturnType<typeof setup>>["tool"];
};

/** The session rents with the reader's $20 on the card: box 9101 on offer 101. */
async function rented(): Promise<Stage> {
  const offers = card();
  const fake = vast(offers);
  const { folder, tool } = await setup(fake);
  await tool("vast_rent").call(RENT, ctxFor([{ row: 0, amount: 20 }]).ctx);
  return { folder, fake, offers, tool };
}

/** The enforcer on the stage's folder, with doubles for ssh, the log, save and destroy. */
function enforcer(stage: Stage, doubles: Partial<EnforceDeps>) {
  const notices: string[] = [];
  const destroyed: number[] = [];
  const api = {
    folder: stage.folder,
    log: () => undefined,
    notify: (text: string) => notices.push(text),
    sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
  } as unknown as ExtensionApi;
  const deps: EnforceDeps = {
    destroy: async (id) => {
      destroyed.push(id);
    },
    onBox: async () => ({ code: 0, out: "", err: "" }),
    keys: async () => ["key"],
    get: stage.fake.get,
    ...doubles,
  };
  const run = new Enforcer(api, { sshKey: null, enforce: true, owner: "jimmy" }, deps);
  return {
    run,
    destroyed,
    /** What was said about broken boxes. */
    told: () => notices.filter((text) => text.includes("is broken")),
  };
}

/** The box of an offer as Vast.ai lists it, started at `startedAt`, at $1 an hour. */
function box(offerId: number, status: string, startedAt: number): Instance {
  return {
    id: 9000 + offerId,
    label: LABEL,
    actual_status: status,
    dph_total: 1,
    start_date: startedAt / 1000,
    machine_id: machineOf(offerId),
    ssh_host: "ssh9.vast.ai",
    ssh_port: 10_000 + offerId,
  };
}

/** The offers the fake Vast.ai was asked to create a box on. */
const asks = (fake: Stage["fake"]) =>
  fake.puts.map((p) => Number(new URL(p.url).pathname.split("/")[4]));

/** One round, and the probes and replacements it started. */
async function round(e: ReturnType<typeof enforcer>, boxes: Instance[], at: number) {
  await e.run.round(boxes, at);
  await e.run.settled();
}

const BAD_MODES =
  "sshd: Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys";

describe("a rent keeps what replaces its box", () => {
  test("the rest of the card, the confirmed budget and what the box was created with", async () => {
    const { folder } = await rented();
    const [lease] = await readLeases(leasesPath(folder));
    expect(lease?.replace).toMatchObject({
      offers: [102, 103, 104, 105],
      excluded: [],
      confirmed: 20,
      spent: 0,
      count: 0,
      machine: 1,
      replaces: null,
      request: { image: "ubuntu:22.04", disk: 40, label: LABEL, onstart: "sleep infinity" },
    });
  });
});

describe("a broken box is replaced within the confirmed budget", () => {
  test("running, but ssh refused for 3 minutes: replaced, its machine left out, the budget carried over", async () => {
    const stage = await rented();
    const probes: number[] = [];
    const e = enforcer(stage, {
      probe: async () => {
        probes.push(1);
        return false;
      },
    });
    // Started 30 minutes before the replacement: $0.50 spent at $1 an hour.
    const started = NOW + 3 * MIN - 30 * MIN;
    for (const minutes of [0, 1, 2]) {
      await round(e, [box(101, "running", started)], NOW + minutes * MIN);
      expect(asks(stage.fake)).toEqual([101]);
    }
    await round(e, [box(101, "running", started)], NOW + 3 * MIN);
    expect(probes).toHaveLength(4);
    // 102 is on the machine that failed, so 103 is rented, with no new card.
    expect(asks(stage.fake)).toEqual([101, 103]);
    expect(stage.fake.puts[1]?.body["label"]).toBe(LABEL);
    const leases = await readLeases(leasesPath(stage.folder));
    expect(leases.find((l) => l.box === 9101)?.cancelled).toBe(true);
    const next = leases.find((l) => l.box === null);
    expect(next?.budget).toBe(19.5);
    expect(next?.replace).toMatchObject({
      offers: [104, 105],
      excluded: [1],
      confirmed: 20,
      spent: 0.5,
      count: 1,
      machine: 3,
      replaces: { box: 9101 },
    });
    const told = e.told();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("job1 (#9101) is broken (ssh refused or timed out for 3m");
    expect(told[0]).toContain("Replaced by #9103");
    expect(told[0]).toContain("$19.50 left of the $20");
    expect(told[0]).toContain("-p 10103 root@ssh9.vast.ai");
  });

  test("the broken box is saved and destroyed the way vast_cancel's is", async () => {
    const stage = await rented();
    const commands: string[] = [];
    const e = enforcer(stage, {
      probe: async () => false,
      logs: async () => BAD_MODES,
      onBox: async (_target, _key, command) => {
        commands.push(command);
        return { code: 0, out: "", err: "" };
      },
    });
    await round(e, [box(101, "running", NOW)], NOW);
    await round(e, [box(101, "running", NOW)], NOW + MIN);
    for (let i = 0; i < 50 && e.destroyed.length === 0; i += 1) await Bun.sleep(20);
    expect(commands.some((c) => c.includes("/root/.lease/save"))).toBe(true);
    expect(e.destroyed).toEqual([9101]);
  });

  test("a log showing bad ownership or modes replaces it at once, without the 3 minutes", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false, logs: async () => BAD_MODES });
    await round(e, [box(101, "running", NOW)], NOW);
    expect(asks(stage.fake)).toEqual([101, 103]);
    expect(e.told()[0]).toContain(
      "is broken (its log shows bad ownership or modes for authorized_keys)",
    );
  });

  test("a log that does not say so, and ssh failing for under 3 minutes, replaces nothing", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false, logs: async () => "starting\nready" });
    await round(e, [box(101, "running", NOW)], NOW);
    await round(e, [box(101, "running", NOW)], NOW + 2 * MIN);
    expect(asks(stage.fake)).toEqual([101]);
    expect(e.told()).toEqual([]);
  });

  test("a box ssh let us into is never replaced for ssh later", async () => {
    const stage = await rented();
    let up = true;
    const e = enforcer(stage, { probe: async () => up });
    await round(e, [box(101, "running", NOW)], NOW);
    up = false;
    for (const minutes of [1, 4, 8]) {
      await round(e, [box(101, "running", NOW)], NOW + minutes * MIN);
    }
    expect(asks(stage.fake)).toEqual([101]);
  });
});

describe("a box that never starts, and what is left to rent", () => {
  test("stuck in created for more than 10 minutes: replaced", async () => {
    const stage = await rented();
    const e = enforcer(stage, {
      probe: async () => {
        throw new Error("a box that is not running is not probed");
      },
    });
    await round(e, [box(101, "created", NOW)], NOW);
    await round(e, [box(101, "created", NOW)], NOW + 10 * MIN);
    expect(asks(stage.fake)).toEqual([101]);
    await round(e, [box(101, "created", NOW)], NOW + 11 * MIN);
    expect(asks(stage.fake)).toEqual([101, 103]);
    expect(e.told()[0]).toContain("stayed created for 11m");
  });

  test("loading counts too, and the wait starts over when the box ran in between", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => true });
    await round(e, [box(101, "loading", NOW)], NOW);
    await round(e, [box(101, "running", NOW)], NOW + 9 * MIN);
    await round(e, [box(101, "loading", NOW)], NOW + 12 * MIN);
    expect(asks(stage.fake)).toEqual([101]);
    await round(e, [box(101, "loading", NOW)], NOW + 23 * MIN);
    expect(asks(stage.fake)).toEqual([101, 103]);
    expect(e.told()[0]).toContain("stayed loading for 11m");
  });

  test("a cancelled lease is not replaced: the session ended the box itself", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false });
    await stage.tool("vast_cancel").call({ name: "job1" }, ctxFor([]).ctx);
    await round(e, [box(101, "created", NOW)], NOW);
    await round(e, [box(101, "created", NOW)], NOW + 30 * MIN);
    expect(asks(stage.fake)).toEqual([101]);
  });

  test("vast_boxes shows the replacement and why", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false, logs: async () => BAD_MODES });
    await round(e, [box(101, "running", NOW)], NOW);
    const text = await stage.tool("vast_boxes").call({}, ctxFor([]).ctx);
    expect(text).toContain(
      "replaces #9101 — its log shows bad ownership or modes for authorized_keys (replacement 1 of 3)",
    );
  });

  test("at most 3 replacements, then one message and no more boxes", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false, logs: async () => BAD_MODES });
    // Each box is broken in turn: 101, then 103, 104 and 105 (102 shares 101's machine).
    let at = NOW;
    for (const id of [101, 103, 104]) {
      await round(e, [box(id, "running", at - 30 * MIN)], at);
      at += H;
    }
    expect(asks(stage.fake)).toEqual([101, 103, 104, 105]);
    const last = (await readLeases(leasesPath(stage.folder))).find((l) => l.box === null);
    // Three broken boxes, $0.50 each, are carried over.
    expect(last?.replace).toMatchObject({ count: 3, spent: 1.5, excluded: [1, 3, 4] });
    expect(last?.budget).toBe(18.5);
    await round(e, [box(105, "running", at - 30 * MIN)], at);
    expect(asks(stage.fake)).toEqual([101, 103, 104, 105]);
    const told = e.told();
    expect(told).toHaveLength(4);
    expect(told[3]).toContain("already replaced 3 broken boxes, so no more are rented");
  });

  test("when no offer fits what is left of the budget, one message says so", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false });
    // Ran 19.8 hours at $1 by the time it counts as stuck: $0.20 of the $20 is left, under every $0.50 offer.
    const old = box(101, "created", NOW + 11 * MIN - 19.8 * H);
    await round(e, [old], NOW);
    await round(e, [old], NOW + 11 * MIN);
    expect(asks(stage.fake)).toEqual([101]);
    const told = e.told();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("No replacement was rented");
    expect(told[0]).toContain("fits the $0.20 that is left of $20");
    // The booking made for the try is dropped again.
    const leases = await readLeases(leasesPath(stage.folder));
    expect(leases.filter((l) => l.box === null)).toEqual([]);
  });

  test("offers that are gone are skipped, and the rest of the card goes on", async () => {
    const stage = await rented();
    const e = enforcer(stage, { probe: async () => false, logs: async () => BAD_MODES });
    // 103 is taken by someone else between the rent and the replacement.
    stage.offers.splice(
      stage.offers.findIndex((o) => o.ask_contract_id === 103),
      1,
    );
    await round(e, [box(101, "running", NOW)], NOW);
    expect(asks(stage.fake)).toEqual([101, 104]);
    expect(e.told()[0]).toContain("Replaced by #9104");
  });
});
