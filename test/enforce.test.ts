import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnforceDeps, Enforcer } from "../enforce";
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
