import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnforceDeps, Enforcer, restDeps } from "../enforce";
import { book, leasesPath, readLeases, updateLeases } from "../leases";
import type { ExtensionApi } from "../prifly-api";
import type { Instance } from "../vast-api";

const NOW = Date.now();
const H = 3_600_000;

const SESSION = "0123abcd-1111-2222-3333-444455556666";

/**
 * A fake host: what was said, a folder of its own, and one session it knows.
 * The boxes are not running, so no ssh.
 */
async function host() {
  const notices: { text: string; session: string | undefined }[] = [];
  const folder = await mkdtemp(join(tmpdir(), "vastai-ext-"));
  const api = {
    folder,
    log: () => undefined,
    notify: (text: string, options?: { session?: string }) =>
      notices.push({ text, session: options?.session }),
    sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
  } as unknown as ExtensionApi;
  return { api, folder, notices };
}

/** A stand-in for destroying over REST that only writes down each id: nothing real is destroyed. */
function fakeDestroy(): { deps: EnforceDeps; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    deps: {
      destroy: async (id) => {
        calls.push(id);
      },
    },
  };
}

const config = (enforce: boolean) => ({
  sshKey: null,
  enforce,
  owner: "jimmy",
});

const box = (id: number, label: string, startedHoursAgo = 2): Instance => ({
  id,
  label,
  actual_status: "exited",
  start_date: (NOW - startedHoursAgo * H) / 1000,
});

test("with enforcement off, a box without a lease is only said to be due", async () => {
  const { api, notices } = await host();
  const enforcer = new Enforcer(api, config(false), fakeDestroy().deps);
  const judged = await enforcer.round([box(1, "jimmy/s-0123abcd/lc-box1"), box(2, "lc-box3")], NOW);
  expect(judged.get(1)?.verdict).toEqual({ kind: "due", reason: "no lease" });
  expect(judged.get(2)?.verdict).toEqual({ kind: "unmanaged" });
  expect(notices).toEqual([
    {
      text: "Would destroy lc-box1 (no lease) — lease enforcement is off, so it is left running.",
      session: "0123abcd",
    },
  ]);
  // Said once, not every minute.
  await enforcer.round([box(1, "jimmy/s-0123abcd/lc-box1")], NOW + 60_000);
  expect(notices).toHaveLength(1);
});

test("a booking binds to its box, and the box then holds the lease", async () => {
  const { api, folder } = await host();
  await updateLeases(leasesPath(folder), (leases) =>
    book(leases, "jimmy/s-0123abcd/lc-box1", 2, NOW),
  );
  const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
  const judged = await enforcer.round([box(1, "jimmy/s-0123abcd/lc-box1", 0)], NOW);
  expect(judged.get(1)?.verdict.kind).toBe("leased");
  expect((await readLeases(leasesPath(folder)))[0]?.box).toBe(1);
});

test("with enforcement on, a due box is destroyed and its lease dropped", async () => {
  const { api, folder, notices } = await host();
  await updateLeases(leasesPath(folder), (leases) =>
    book(leases, "jimmy/s-0123abcd/lc-box1", 1, NOW - 3 * H),
  );
  const fake = fakeDestroy();
  const enforcer = new Enforcer(api, config(true), fake.deps);
  const boxes = [box(1, "jimmy/s-0123abcd/lc-box1")];
  await enforcer.round(boxes, NOW);
  // Bound now, and over by two hours: due. The take-down runs in the background.
  await enforcer.round(boxes, NOW);
  for (let i = 0; i < 50 && !notices.some((n) => n.text.startsWith("Destroyed")); i += 1) {
    await Bun.sleep(20);
  }
  expect(notices.map((n) => n.text)).toContain(
    "Destroyed lc-box1 (lease over); it no longer bills.",
  );
  expect(await readLeases(leasesPath(folder))).toEqual([]);
  expect(fake.calls).toEqual([1]);
});

test("the older label is still this owner's, and is enforced", async () => {
  const { api, notices } = await host();
  const enforcer = new Enforcer(api, config(false), fakeDestroy().deps);
  const judged = await enforcer.round([box(1, "s-0123abcd/lc-box1")], NOW);
  expect(judged.get(1)?.verdict).toEqual({ kind: "due", reason: "no lease" });
  expect(notices.map((n) => n.text)).toEqual([
    "Would destroy lc-box1 (no lease) — lease enforcement is off, so it is left running.",
  ]);
});

test("another owner's box and an unknown session's box are never destroyed", async () => {
  const { api, folder, notices } = await host();
  // Leases that would be long over, had these boxes been this prifly's.
  await updateLeases(leasesPath(folder), (leases) => ({
    leases: [
      ...book(leases, "anna/s-0123abcd/lc-box1", 1, NOW - 3 * H).leases,
      ...book([], "jimmy/s-99999999/lc-box2", 1, NOW - 3 * H).leases,
    ],
    result: null,
  }));
  const fake = fakeDestroy();
  const enforcer = new Enforcer(api, config(true), fake.deps);
  const boxes = [box(1, "anna/s-0123abcd/lc-box1"), box(2, "jimmy/s-99999999/lc-box2")];
  for (let round = 0; round < 3; round += 1) {
    const judged = await enforcer.round(boxes, NOW + round * 60_000);
    expect(judged.get(1)?.verdict).toEqual({ kind: "foreign", owner: "anna" });
    expect(judged.get(2)?.verdict).toEqual({ kind: "stranger", session: "99999999" });
  }
  await Bun.sleep(100);
  expect(fake.calls).toEqual([]);
  // The stranger is warned about once; the other owner's box is not this prifly's to mention.
  expect(notices).toEqual([
    {
      text: "lc-box2 is labelled for session 99999999, which is not this prifly's session: it is never destroyed here.",
      session: undefined,
    },
  ]);
});

/** A running-looking box that bills `rate` an hour and started `hoursAgo` ago (not running, so no ssh). */
const billing = (id: number, label: string, hoursAgo: number, rate: number): Instance => ({
  ...box(id, label, hoursAgo),
  dph_total: rate,
});

async function budgeted(budget: number, hours: number) {
  const ctx = await host();
  await updateLeases(leasesPath(ctx.folder), (leases) =>
    book(leases, "jimmy/s-0123abcd/lc-box1", hours, NOW - 2 * H, budget),
  );
  return ctx;
}

describe("budget", () => {
  test("90 % of the budget is told once, naming the session", async () => {
    const { api, folder, notices } = await budgeted(10, 20);
    const fake = fakeDestroy();
    const enforcer = new Enforcer(api, config(true), fake.deps);
    // Two hours at 4.6 an hour: 9.20 of 10.
    const boxes = [billing(1, "jimmy/s-0123abcd/lc-box1", 2, 4.6)];
    await enforcer.round(boxes, NOW);
    await enforcer.round(boxes, NOW + 60_000);
    await enforcer.round(boxes, NOW + 120_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.session).toBe("0123abcd");
    expect(notices[0]?.text).toContain("lc-box1 has cost $9.20 of $10");
    expect(fake.calls).toEqual([]);
    expect((await readLeases(leasesPath(folder)))[0]?.budget).toBe(10);
  });

  test("below 90 % nothing is said", async () => {
    const { api, notices } = await budgeted(10, 20);
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    await enforcer.round([billing(1, "jimmy/s-0123abcd/lc-box1", 2, 4)], NOW);
    expect(notices).toEqual([]);
  });

  test("a raised budget is told again when it is nearly spent", async () => {
    const { api, folder, notices } = await budgeted(10, 20);
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    const boxes = [billing(1, "jimmy/s-0123abcd/lc-box1", 2, 4.6)];
    await enforcer.round(boxes, NOW);
    await updateLeases(leasesPath(folder), (leases) => ({
      leases: leases.map((l) => ({ ...l, budget: 20 })),
      result: null,
    }));
    await enforcer.round(boxes, NOW + 60_000);
    expect(notices).toHaveLength(1);
    // 18.40 of 20 is 92 %.
    await enforcer.round([billing(1, "jimmy/s-0123abcd/lc-box1", 4, 4.6)], NOW);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toContain("$18.40 of $20");
  });

  test("at 100 % the box is saved and destroyed, reason budget reached", async () => {
    const { api, folder, notices } = await budgeted(10, 20);
    const fake = fakeDestroy();
    const enforcer = new Enforcer(api, config(true), fake.deps);
    // The lease has 18 hours left; 5.2 an hour for 2 hours is 10.40.
    const boxes = [billing(1, "jimmy/s-0123abcd/lc-box1", 2, 5.2)];
    const judged = await enforcer.round(boxes, NOW);
    expect(judged.get(1)?.verdict).toEqual({ kind: "due", reason: "budget reached" });
    for (let i = 0; i < 50 && !notices.some((n) => n.text.startsWith("Destroyed")); i += 1) {
      await Bun.sleep(20);
    }
    expect(notices.map((n) => n.text)).toContain(
      "Destroyed lc-box1 (budget reached); it no longer bills.",
    );
    expect(fake.calls).toEqual([1]);
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("with enforcement off it only says it would destroy", async () => {
    const { api, notices } = await budgeted(10, 20);
    const fake = fakeDestroy();
    const enforcer = new Enforcer(api, config(false), fake.deps);
    await enforcer.round([billing(1, "jimmy/s-0123abcd/lc-box1", 2, 5.2)], NOW);
    await Bun.sleep(50);
    expect(fake.calls).toEqual([]);
    expect(notices.map((n) => n.text)).toEqual([
      "Would destroy lc-box1 (budget reached) — lease enforcement is off, so it is left running.",
    ]);
  });

  test("the lease end shown is held to the hour the budget runs out", async () => {
    const { api } = await budgeted(10, 20);
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    // 4 an hour, started 1 hour ago: 10 dollars last until 1.5 hours from now.
    const judged = await enforcer.round([billing(1, "jimmy/s-0123abcd/lc-box1", 1, 4)], NOW);
    expect(judged.get(1)?.until).toBe(Math.floor(NOW + 1.5 * H));
    expect(judged.get(1)?.spent).toBeCloseTo(4, 6);
    expect(judged.get(1)?.budget).toBe(10);
  });

  test("a lease without a budget never ends on cost", async () => {
    const { api, folder } = await host();
    await updateLeases(leasesPath(folder), (leases) =>
      book(leases, "jimmy/s-0123abcd/lc-box1", 20, NOW - 2 * H),
    );
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    const judged = await enforcer.round([billing(1, "jimmy/s-0123abcd/lc-box1", 2, 500)], NOW);
    expect(judged.get(1)?.verdict.kind).toBe("leased");
  });
});

describe("the host's end date", () => {
  /** A running box with an address, its lease long (20 h left), its host's end date `endsIn` ms away. */
  const hosted = (endsIn: number | null): Instance => ({
    ...box(1, "jimmy/s-0123abcd/lc-box1", 1),
    actual_status: "running",
    ssh_host: "ssh1.vast.ai",
    ssh_port: 20001,
    end_date: endsIn === null ? null : (NOW + endsIn) / 1000,
  });

  async function leased() {
    const ctx = await host();
    await updateLeases(leasesPath(ctx.folder), (leases) =>
      book(leases, "jimmy/s-0123abcd/lc-box1", 21, NOW - H),
    );
    return ctx;
  }

  async function destroyed(notices: { text: string }[]) {
    for (let i = 0; i < 50 && !notices.some((n) => n.text.startsWith("Destroyed")); i += 1) {
      await Bun.sleep(20);
    }
  }

  test("a box that ends in 20 minutes is saved while running, then destroyed, though its lease runs for hours", async () => {
    const { api, folder, notices } = await leased();
    const fake = fakeDestroy();
    const commands: string[] = [];
    const deps = {
      ...fake.deps,
      onBox: async (_target: unknown, _key: unknown, command: string) => {
        commands.push(command);
        return { code: 0, out: "", err: "" };
      },
    };
    const enforcer = new Enforcer(api, config(true), deps);
    const boxes = [hosted(20 * 60_000)];
    await enforcer.round(boxes, NOW); // binds the lease
    const judged = await enforcer.round(boxes, NOW);
    expect(judged.get(1)?.verdict).toEqual({
      kind: "due",
      reason: "the host's end date is near",
    });
    await destroyed(notices);
    expect(commands.some((c) => c.includes("/root/.lease/save"))).toBe(true);
    expect(fake.calls).toEqual([1]);
    expect(notices.map((n) => n.text)).toContain(
      "Destroyed lc-box1 (the host's end date is near); it no longer bills.",
    );
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("with enforcement off it only says it would destroy", async () => {
    const { api, notices } = await leased();
    const fake = fakeDestroy();
    await new Enforcer(api, config(false), fake.deps).round([hosted(20 * 60_000)], NOW);
    await Bun.sleep(50);
    expect(fake.calls).toEqual([]);
    expect(notices.map((n) => n.text)).toEqual([
      "Would destroy lc-box1 (the host's end date is near) — lease enforcement is off, so it is left running.",
    ]);
  });

  test("a box that ends in more than 30 minutes is left alone, as is one with no end date", async () => {
    const { api } = await leased();
    const fake = fakeDestroy();
    const enforcer = new Enforcer(api, config(true), {
      ...fake.deps,
      onBox: async () => ({ code: 0, out: "", err: "" }),
    });
    for (const endsIn of [31 * 60_000, 5 * H, null]) {
      const judged = await enforcer.round([hosted(endsIn)], NOW);
      expect(judged.get(1)?.verdict.kind).toBe("leased");
    }
    await Bun.sleep(50);
    expect(fake.calls).toEqual([]);
  });
});

test("the enforcer destroys with the key from prifly's vault, before any key file", async () => {
  const seen: { url: string; auth: string }[] = [];
  const get = async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("Authorization") ?? "" });
    return new Response("{}", { status: 200 });
  };
  const vault = { read: async (name: string) => (name === "vastai" ? "vaulted-key" : null) };
  await restDeps(vault, get).destroy(42);
  expect(seen).toEqual([
    { url: expect.stringContaining("/api/v0/instances/42/"), auth: "Bearer vaulted-key" },
  ]);
});

describe("the account's credit", () => {
  const running = (id: number, label: string, rate: number, startedHoursAgo = 1): Instance => ({
    id,
    label,
    actual_status: "running",
    dph_total: rate,
    start_date: (NOW - startedHoursAgo * H) / 1000,
  });

  test("the runway is told once per warning, to the session that owns a box, and again after a top-up", async () => {
    const { api, notices } = await host();
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    const boxes = [running(1, "jimmy/s-0123abcd/job1", 2)];
    // $20 at $2/h: 10 h, under the 12 h warning.
    enforcer.creditRound({ credit: 20, threshold: null }, boxes, [], NOW);
    enforcer.creditRound({ credit: 19.9, threshold: null }, boxes, [], NOW + 60_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.session).toBe("0123abcd");
    expect(notices[0]?.text).toStartWith(
      "Vast credit $20.00 lasts about 10h 0m at the account's burn of $2.00/h",
    );
    // 2.5 h: under the 3 h warning.
    enforcer.creditRound({ credit: 5, threshold: null }, boxes, [], NOW + 2 * 60_000);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toContain("lasts about 2h 30m");
    // Topped up: said, and the warnings may come again.
    const view = enforcer.creditRound(
      { credit: 105, threshold: null },
      boxes,
      [],
      NOW + 3 * 60_000,
    );
    expect(view.runway).toBe(52.5);
    expect(notices[2]?.text).toBe(
      "Vast credit topped up to $105.00: it now lasts 52h 30m at the account's burn.",
    );
    enforcer.creditRound({ credit: 20, threshold: null }, boxes, [], NOW + 4 * 60_000);
    expect(notices).toHaveLength(4);
  });

  test("a box whose budget runs past the credit's end is told to its session, once per budget", async () => {
    const { api, notices } = await host();
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    const boxes = [running(1, "jimmy/s-0123abcd/job1", 2)];
    const leases = [
      {
        label: "jimmy/s-0123abcd/job1",
        box: 1,
        bookedAt: NOW - H,
        until: NOW + 10 * H,
        cancelled: false,
        budget: 60,
      },
    ];
    // $50 lasts 25 h; the box needs $58 more, 29 h.
    enforcer.creditRound({ credit: 50, threshold: null }, boxes, leases, NOW);
    enforcer.creditRound({ credit: 50, threshold: null }, boxes, leases, NOW + 60_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.session).toBe("0123abcd");
    expect(notices[0]?.text).toStartWith(
      "job1 needs $58.00 more to reach its budget (29h 0m), but the Vast credit runs out in about 25h 0m",
    );
  });

  test("with nothing of this prifly's billing, a low runway goes to the status bar", async () => {
    const { api, notices } = await host();
    const enforcer = new Enforcer(api, config(true), fakeDestroy().deps);
    enforcer.creditRound({ credit: 1, threshold: null }, [running(9, "rj-judge:1:2", 2)], [], NOW);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.session).toBeUndefined();
  });
});
