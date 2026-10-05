import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  book,
  cancel,
  extend,
  type Lease,
  leaseOf,
  leasesPath,
  MAX_AHEAD_MS,
  raiseBudget,
  readLeases,
  tidy,
  UNUSED_BOOKING_MS,
  updateLeases,
} from "../leases";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const LABEL = "s-0123abcd/lc-box1";

describe("book", () => {
  test("books a label not rented yet", () => {
    const { leases, result } = book([], LABEL, 2, NOW);
    expect(result).toEqual({
      label: LABEL,
      box: null,
      bookedAt: NOW,
      until: NOW + 2 * H,
      cancelled: false,
      budget: null,
      replace: null,
    });
    expect(leases).toEqual([result]);
  });

  test("booking a label again replaces its unused booking, not a bound lease", () => {
    const bound: Lease = {
      label: LABEL,
      box: 7,
      bookedAt: 0,
      until: NOW,
      cancelled: false,
      budget: null,
    };
    const first = book([bound], LABEL, 1, NOW).leases;
    const { leases } = book(first, LABEL, 3, NOW);
    expect(leases).toHaveLength(2);
    expect(leases.find((l) => l.box === null)?.until).toBe(NOW + 3 * H);
  });

  test("refuses more than a day ahead, and no hours", () => {
    expect(() => book([], LABEL, MAX_AHEAD_MS / H + 1, NOW)).toThrow("at most");
    expect(() => book([], LABEL, 0, NOW)).toThrow("hours");
  });
});

describe("extend", () => {
  const lease: Lease = {
    label: LABEL,
    box: 7,
    bookedAt: NOW,
    until: NOW + H,
    cancelled: false,
    budget: null,
  };

  test("adds to a running lease", () => {
    expect(extend([lease], { box: 7 }, 2, NOW).result.until).toBe(NOW + 3 * H);
  });

  test("counts from now for a lease that is over", () => {
    const over = { ...lease, until: NOW - 10 * 60_000 };
    expect(extend([over], { label: LABEL }, 1, NOW).result.until).toBe(NOW + H);
  });

  test("without a lease it throws, unless the box is adopted", () => {
    expect(() => extend([], { box: 9 }, 1, NOW)).toThrow("No lease");
    const { result } = extend([], { box: 9 }, 1, NOW, { box: 9, label: "s-0123abcd/x" });
    expect(result).toEqual({
      label: "s-0123abcd/x",
      box: 9,
      bookedAt: NOW,
      until: NOW + H,
      cancelled: false,
      budget: null,
      replace: null,
    });
  });

  test("un-cancels a cancelled lease", () => {
    expect(extend([{ ...lease, cancelled: true }], { box: 7 }, 1, NOW).result.cancelled).toBe(
      false,
    );
  });
});

describe("cancel", () => {
  test("marks a bound lease cancelled and drops an unused booking", () => {
    const bound: Lease = {
      label: LABEL,
      box: 7,
      bookedAt: NOW,
      until: NOW + H,
      cancelled: false,
      budget: null,
    };
    expect(cancel([bound], { box: 7 }).leases).toEqual([{ ...bound, cancelled: true }]);
    const booked = book([], "s-0123abcd/b", 1, NOW).leases;
    expect(cancel(booked, { label: "s-0123abcd/b" }).leases).toEqual([]);
  });
});

describe("tidy", () => {
  test("binds a booking to the box that carries its label, once", () => {
    const leases = book([], LABEL, 1, NOW).leases;
    const boxes = [
      { id: 1, label: LABEL },
      { id: 2, label: LABEL },
    ];
    const tidied = tidy(leases, boxes, NOW);
    expect(tidied.changed).toBe(true);
    expect(tidied.leases.map((l) => l.box)).toEqual([1]);
    expect(leaseOf(tidied.leases, 2, LABEL)).toBeNull();
  });

  test("drops leases whose box is gone and bookings never used", () => {
    const gone: Lease = {
      label: LABEL,
      box: 5,
      bookedAt: NOW,
      until: NOW + H,
      cancelled: false,
      budget: null,
    };
    const stale = book([], "s-0123abcd/old", 1, NOW - UNUSED_BOOKING_MS - 1).result;
    const fresh = book([], "s-0123abcd/new", 1, NOW).result;
    const tidied = tidy([gone, stale, fresh], [], NOW);
    expect(tidied.leases).toEqual([fresh]);
  });

  test("says nothing changed when nothing did", () => {
    const bound: Lease = {
      label: LABEL,
      box: 5,
      bookedAt: NOW,
      until: NOW + H,
      cancelled: false,
      budget: null,
    };
    expect(tidy([bound], [{ id: 5, label: LABEL }], NOW).changed).toBe(false);
  });
});

test("updateLeases writes the file whole, under the lock, in parallel", async () => {
  const path = leasesPath(await mkdtemp(join(tmpdir(), "vastlease-")));
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      updateLeases(path, (leases) => book(leases, `s-0123abcd/b${i}`, 1, NOW)),
    ),
  );
  expect(await readLeases(path)).toHaveLength(20);
});

describe("budget", () => {
  test("a booking carries the confirmed budget, and an older file reads as none", async () => {
    expect(book([], LABEL, 2, NOW, 7.5).result.budget).toBe(7.5);
    const folder = await mkdtemp(join(tmpdir(), "vastai-leases-"));
    const path = leasesPath(folder);
    // A lease written before budgets existed has no `budget` key.
    await Bun.write(
      path,
      JSON.stringify({
        leases: [{ label: LABEL, box: 7, bookedAt: NOW, until: NOW + H, cancelled: false }],
      }),
    );
    expect((await readLeases(path))[0]?.budget).toBeNull();
  });

  test("raiseBudget sets the confirmed amount and keeps the rest", () => {
    const lease: Lease = {
      label: LABEL,
      box: 7,
      bookedAt: NOW,
      until: NOW + H,
      cancelled: false,
      budget: 5,
    };
    const { leases, result } = raiseBudget([lease], { box: 7 }, 12.5);
    expect(result).toEqual({ ...lease, budget: 12.5 });
    expect(leases).toEqual([result]);
    expect(() => raiseBudget([lease], { box: 8 }, 1)).toThrow("No lease");
    expect(() => raiseBudget([lease], { box: 7 }, 0)).toThrow("Not a budget");
  });
});
