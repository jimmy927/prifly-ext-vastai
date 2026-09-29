import { describe, expect, test } from "bun:test";
import type { Lease } from "../leases";
import { BOOKING_MS, GRACE_MS, IDLE_NET_KIB, IdleWatch, judge, span } from "../rules";

const NOW = 1_800_000_000_000;
const M = 60_000;
const BOX = { id: 7, label: "s-0123abcd/lc-box1", startedAt: NOW - 60 * M };
const lease = (until: number, cancelled = false): Lease => ({
  label: BOX.label,
  box: 7,
  bookedAt: NOW - 120 * M,
  until,
  cancelled,
});

describe("judge", () => {
  test("leaves boxes rented by hand or by other software alone", () => {
    for (const label of [
      "",
      "lc-box3",
      "rj-reranker:38596:48445",
      "project-odi/lc-box1",
      "s-XYZ/a",
    ]) {
      expect(judge({ ...BOX, label }, null, NOW)).toEqual({ kind: "unmanaged" });
    }
  });

  test("a session's box without a lease gets only the booking window", () => {
    expect(judge({ ...BOX, startedAt: NOW - M }, null, NOW)).toEqual({
      kind: "unbooked",
      leftMs: BOOKING_MS - M,
    });
    expect(judge(BOX, null, NOW)).toEqual({ kind: "due", reason: "no lease" });
  });

  test("a lease runs, ends, has its grace, then is due", () => {
    expect(judge(BOX, lease(NOW + 60 * M), NOW)).toEqual({ kind: "leased", leftMs: 60 * M });
    expect(judge(BOX, lease(NOW + 10 * M), NOW)).toEqual({ kind: "ending", leftMs: 10 * M });
    expect(judge(BOX, lease(NOW - 5 * M), NOW)).toEqual({
      kind: "grace",
      leftMs: GRACE_MS - 5 * M,
    });
    expect(judge(BOX, lease(NOW - GRACE_MS), NOW)).toEqual({ kind: "due", reason: "lease over" });
  });

  test("a cancelled lease is due at once", () => {
    expect(judge(BOX, lease(NOW + 60 * M, true), NOW)).toEqual({
      kind: "due",
      reason: "cancelled",
    });
  });
});

describe("IdleWatch", () => {
  test("low CPU and GPU with no traffic adds up; traffic or load starts it again", () => {
    const watch = new IdleWatch();
    const quiet = { cpu: 0.1, gpu: 0, netKiB: 1000 };
    expect(watch.observe(1, quiet, NOW)).toBe(0);
    expect(watch.observe(1, quiet, NOW + 30 * M)).toBe(30 * M);
    // Downloading a dataset: 0 % CPU, but the traffic grows.
    expect(watch.observe(1, { ...quiet, netKiB: 1000 + IDLE_NET_KIB + 1 }, NOW + 31 * M)).toBe(0);
    expect(watch.observe(1, { ...quiet, netKiB: 1000 + IDLE_NET_KIB + 1 }, NOW + 40 * M)).toBe(
      9 * M,
    );
    expect(watch.observe(1, { ...quiet, gpu: 90 }, NOW + 41 * M)).toBe(0);
  });

  test("forgets boxes that are gone", () => {
    const watch = new IdleWatch();
    watch.observe(1, { cpu: 0, gpu: 0, netKiB: 0 }, NOW);
    watch.keep(new Set());
    expect(watch.observe(1, { cpu: 0, gpu: 0, netKiB: 0 }, NOW + 90 * M)).toBe(0);
  });
});

test("span", () => {
  expect(span(100 * M)).toBe("1h 40m");
  expect(span(12 * M)).toBe("12m");
  expect(span(45_000)).toBe("45s");
  expect(span(-1)).toBe("0s");
});
