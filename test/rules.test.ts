import { describe, expect, test } from "bun:test";
import type { Lease } from "../leases";
import {
  BOOKING_MS,
  GRACE_MS,
  IDLE_CORES,
  IDLE_NET_KIB,
  IdleWatch,
  isOwnBox,
  judge,
  type Mine,
  ownerName,
  parseLabel,
  sessionLabel,
  span,
} from "../rules";

const NOW = 1_800_000_000_000;
const M = 60_000;
const BOX = { id: 7, label: "jimmy/s-0123abcd/lc-box1", startedAt: NOW - 60 * M };
const MINE: Mine = { owner: "jimmy", sessions: ["0123abcd-1111-2222-3333-444455556666"] };
const lease = (until: number, cancelled = false): Lease => ({
  label: BOX.label,
  box: 7,
  bookedAt: NOW - 120 * M,
  until,
  cancelled,
  budget: null,
});

describe("judge", () => {
  test("leaves boxes rented by hand or by other software alone", () => {
    for (const label of [
      "",
      "lc-box3",
      "rj-reranker:38596:48445",
      "project-odi/lc-box1",
      "s-XYZ/a",
      "Jimmy/s-0123abcd/a",
      "a-far-too-long-owner-name/s-0123abcd/a",
    ]) {
      expect(judge({ ...BOX, label }, null, NOW, MINE)).toEqual({ kind: "unmanaged" });
    }
  });

  test("a session's box without a lease gets only the booking window", () => {
    expect(judge({ ...BOX, startedAt: NOW - M }, null, NOW, MINE)).toEqual({
      kind: "unbooked",
      leftMs: BOOKING_MS - M,
    });
    expect(judge(BOX, null, NOW, MINE)).toEqual({ kind: "due", reason: "no lease" });
  });

  test("a lease runs, ends, has its grace, then is due", () => {
    expect(judge(BOX, lease(NOW + 60 * M), NOW, MINE)).toEqual({ kind: "leased", leftMs: 60 * M });
    expect(judge(BOX, lease(NOW + 10 * M), NOW, MINE)).toEqual({ kind: "ending", leftMs: 10 * M });
    expect(judge(BOX, lease(NOW - 5 * M), NOW, MINE)).toEqual({
      kind: "grace",
      leftMs: GRACE_MS - 5 * M,
    });
    expect(judge(BOX, lease(NOW - GRACE_MS), NOW, MINE)).toEqual({
      kind: "due",
      reason: "lease over",
    });
  });

  test("a cancelled lease is due at once", () => {
    expect(judge(BOX, lease(NOW + 60 * M, true), NOW, MINE)).toEqual({
      kind: "due",
      reason: "cancelled",
    });
  });
});

describe("labels", () => {
  test("parses the owner form and the older one, which has no owner", () => {
    expect(parseLabel("jimmy/s-0123abcd/lc-box1")).toEqual({
      owner: "jimmy",
      session: "0123abcd",
      name: "lc-box1",
    });
    expect(parseLabel("s-0123abcd/lc-box1")).toEqual({
      owner: null,
      session: "0123abcd",
      name: "lc-box1",
    });
    expect(parseLabel("project-odi/lc-box1")).toBeNull();
    expect(sessionLabel("jimmy", "0123abcd-1111", "lc-box1")).toBe("jimmy/s-0123abcd/lc-box1");
  });

  test("an owner is lower-case, [a-z0-9_-] only, at most 16 characters", () => {
    expect(ownerName("Jimmy")).toBe("jimmy");
    expect(ownerName("jimmy.engelbrecht@artemis")).toBe("jimmyengelbrecht");
    expect(ownerName("Build_Bot-2")).toBe("build_bot-2");
    expect(ownerName("åäö")).toBe("");
  });

  test("a box is this owner's by its owner, or by the older label", () => {
    expect(isOwnBox("jimmy/s-0123abcd/a", "jimmy")).toBe(true);
    expect(isOwnBox("s-0123abcd/a", "jimmy")).toBe(true);
    expect(isOwnBox("anna/s-0123abcd/a", "jimmy")).toBe(false);
    expect(isOwnBox("lc-box3", "jimmy")).toBe(false);
  });
});

describe("judge: whose box", () => {
  test("another owner's box is never judged, whatever its lease", () => {
    const theirs = { ...BOX, label: "anna/s-0123abcd/lc-box1" };
    expect(judge(theirs, null, NOW, MINE)).toEqual({ kind: "foreign", owner: "anna" });
    expect(judge(theirs, lease(NOW - GRACE_MS, true), NOW, MINE).kind).toBe("foreign");
  });

  test("a box of a session this prifly does not know is never due", () => {
    const unknown = { ...BOX, label: "jimmy/s-99999999/lc-box1" };
    expect(judge(unknown, null, NOW, MINE)).toEqual({ kind: "stranger", session: "99999999" });
    expect(judge(unknown, lease(NOW - GRACE_MS, true), NOW, MINE).kind).toBe("stranger");
    expect(judge(BOX, null, NOW, { ...MINE, sessions: [] }).kind).toBe("stranger");
  });

  test("the older label counts as this owner's, and still needs a known session", () => {
    const legacy = { ...BOX, label: "s-0123abcd/lc-box1" };
    expect(judge(legacy, null, NOW, MINE)).toEqual({ kind: "due", reason: "no lease" });
    expect(judge(legacy, lease(NOW + 60 * M), NOW, MINE).kind).toBe("leased");
    expect(judge({ ...legacy, label: "s-99999999/x" }, null, NOW, MINE).kind).toBe("stranger");
  });
});

describe("IdleWatch", () => {
  test("few busy cores and a quiet GPU with no traffic adds up; traffic or load starts it again", () => {
    const watch = new IdleWatch();
    const quiet = { coresBusy: 0.1, gpu: 0, netKiB: 1000 };
    expect(watch.observe(1, quiet, NOW)).toBe(0);
    expect(watch.observe(1, quiet, NOW + 30 * M)).toBe(30 * M);
    // Downloading a dataset: 0 cores busy, but the traffic grows.
    expect(watch.observe(1, { ...quiet, netKiB: 1000 + IDLE_NET_KIB + 1 }, NOW + 31 * M)).toBe(0);
    expect(watch.observe(1, { ...quiet, netKiB: 1000 + IDLE_NET_KIB + 1 }, NOW + 40 * M)).toBe(
      9 * M,
    );
    expect(watch.observe(1, { ...quiet, gpu: 90 }, NOW + 41 * M)).toBe(0);
  });

  test("a CPU-only box (no GPU) is quiet for the GPU", () => {
    const watch = new IdleWatch();
    const quiet = { coresBusy: 0, gpu: null, netKiB: 0 };
    watch.observe(1, quiet, NOW);
    expect(watch.observe(1, quiet, NOW + 10 * M)).toBe(10 * M);
  });

  test("one busy core of a big host is not idle", () => {
    const watch = new IdleWatch();
    // cpu_util 0.2604 of 384 cores: the % is far below IDLE_PCT, the core is not.
    const busy = { coresBusy: (0.2604 / 100) * 384, gpu: null, netKiB: 0 };
    watch.observe(1, { ...busy, coresBusy: 0.1 }, NOW);
    expect(watch.observe(1, busy, NOW + 10 * M)).toBe(0);
    expect(watch.observe(1, busy, NOW + 20 * M)).toBe(0);
    // 0.4 cores is still quiet; 0.5 is not.
    const watch2 = new IdleWatch();
    watch2.observe(2, { ...busy, coresBusy: IDLE_CORES - 0.1 }, NOW);
    expect(watch2.observe(2, { ...busy, coresBusy: IDLE_CORES - 0.1 }, NOW + M)).toBe(M);
    expect(watch2.observe(2, { ...busy, coresBusy: IDLE_CORES }, NOW + 2 * M)).toBe(0);
  });

  test("a dropped GPU sample neither starts nor breaks a stretch of idleness", () => {
    const watch = new IdleWatch();
    const quiet = { coresBusy: 0, gpu: 0, netKiB: 0 };
    const dropout = { ...quiet, gpu: "unknown" as const };
    // Nothing seen yet: a dropout starts nothing, so the next real read starts at 0.
    expect(watch.observe(1, dropout, NOW)).toBe(0);
    expect(watch.observe(1, quiet, NOW + M)).toBe(0);
    expect(watch.observe(1, dropout, NOW + 5 * M)).toBe(4 * M);
    // Even a busy CPU on a dropout resets nothing.
    expect(watch.observe(1, { ...dropout, coresBusy: 50 }, NOW + 6 * M)).toBe(5 * M);
    expect(watch.observe(1, quiet, NOW + 10 * M)).toBe(9 * M);
  });

  test("forgets boxes that are gone", () => {
    const watch = new IdleWatch();
    watch.observe(1, { coresBusy: 0, gpu: 0, netKiB: 0 }, NOW);
    watch.keep(new Set());
    expect(watch.observe(1, { coresBusy: 0, gpu: 0, netKiB: 0 }, NOW + 90 * M)).toBe(0);
  });
});

test("span", () => {
  expect(span(100 * M)).toBe("1h 40m");
  expect(span(12 * M)).toBe("12m");
  expect(span(45_000)).toBe("45s");
  expect(span(-1)).toBe("0s");
});
