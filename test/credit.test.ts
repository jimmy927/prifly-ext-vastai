import { describe, expect, test } from "bun:test";
import {
  accountBurn,
  burnOf,
  CREDIT_DEFAULTS,
  commitmentText,
  committedOf,
  creditLine,
  marginOf,
  maxBudget,
  overText,
  runwayHours,
} from "../credit";
import type { Lease } from "../leases";
import type { Instance } from "../vast-api";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const running = (id: number, label: string, rate: number, startedHoursAgo = 0): Instance => ({
  id,
  label,
  actual_status: "running",
  dph_total: rate,
  storage_total_cost: 0.05,
  start_date: (NOW - startedHoursAgo * H) / 1000,
});

const stopped = (id: number, label: string, storage: number): Instance => ({
  id,
  label,
  actual_status: "exited",
  dph_total: 0.8,
  storage_total_cost: storage,
  start_date: NOW / 1000,
});

const lease = (more: Partial<Lease>): Lease => ({
  label: "",
  box: null,
  bookedAt: NOW,
  until: NOW + 10 * H,
  cancelled: false,
  budget: null,
  ...more,
});

describe("burn", () => {
  test("a running box bills its rate, a stopped one its disk", () => {
    expect(burnOf(running(1, "a", 1.2))).toBe(1.2);
    expect(burnOf(stopped(2, "b", 0.04))).toBe(0.04);
    expect(accountBurn([running(1, "a", 1.2), stopped(2, "b", 0.04)])).toBeCloseTo(1.24);
  });
});

describe("committedOf", () => {
  // jtrain2 is 20 h into a $60 budget at $1; two serverless workers are stopped;
  // a box rented by hand runs at $0.50; another session has booked $20.
  const boxes = [
    running(1, "jimmy/s-0123abcd/jtrain2", 1, 20),
    stopped(2, "rj-judge:39180:49020", 0.05),
    stopped(3, "rj-reranker:38596:49000", 0.05),
    running(4, "handmade", 0.5),
  ];
  const leases = [
    lease({ label: "jimmy/s-0123abcd/jtrain2", box: 1, budget: 60 }),
    lease({ label: "jimmy/s-99999999/next", budget: 20 }),
  ];

  test("each box's rest of budget, every other box's burn over the horizon, and bookings", () => {
    const committed = committedOf(boxes, leases, NOW, CREDIT_DEFAULTS);
    expect(committed.items).toEqual([
      { kind: "budget", name: "jtrain2", dollars: 40 },
      { kind: "serverless", name: "rj-judge", dollars: 0.05 * 24 },
      { kind: "serverless", name: "rj-reranker", dollars: 0.05 * 24 },
      { kind: "other", name: "handmade", dollars: 12 },
      { kind: "booking", name: "next", dollars: 20 },
    ]);
    expect(committed.total).toBeCloseTo(74.4);
    expect(committed.burn).toBeCloseTo(1.6);
    expect(commitmentText(committed.items, CREDIT_DEFAULTS)).toBe(
      "jtrain2: $40.00 left of its budget · booking next: $20.00 · serverless rj-judge, rj-reranker: $2.40 over 24 h · other boxes handmade: $12.00 at most",
    );
  });

  test("the box or booking a card asks about is left out", () => {
    const committed = committedOf(boxes, leases, NOW, CREDIT_DEFAULTS, {
      box: 1,
      label: "jimmy/s-99999999/next",
    });
    expect(committed.items.map((item) => item.name)).toEqual([
      "rj-judge",
      "rj-reranker",
      "handmade",
    ]);
    expect(committed.burn).toBeCloseTo(0.6);
  });

  test("a leased box with no budget counts until its lease ends", () => {
    const committed = committedOf(
      [running(1, "jimmy/s-0123abcd/old", 2)],
      [lease({ label: "jimmy/s-0123abcd/old", box: 1, until: NOW + 3 * H })],
      NOW,
      CREDIT_DEFAULTS,
    );
    expect(committed.total).toBe(6);
  });
});

describe("the limit", () => {
  const committed = { items: [], total: 40, burn: 1 };

  test("keeps the larger of the share and the hours of burn free", () => {
    expect(marginOf(60, committed, 1, CREDIT_DEFAULTS)).toBe(10);
    expect(marginOf(10, committed, 1, CREDIT_DEFAULTS)).toBe(6);
  });

  test("the largest budget that leaves the margin, in whole dollars from ten up", () => {
    // 120 − 40 = 80 free: 80 / 1.1 = 72.7 by the share, 80 − 3 × 2 = 74 by the hours.
    expect(maxBudget({ credit: 120, threshold: -0.01 }, committed, 1, CREDIT_DEFAULTS)).toBe(72);
    expect(maxBudget({ credit: 45, threshold: null }, committed, 1, CREDIT_DEFAULTS)).toBe(0);
    expect(maxBudget({ credit: 50, threshold: null }, committed, 1, CREDIT_DEFAULTS)).toBe(4);
  });

  test("a positive threshold is held back from the credit", () => {
    expect(maxBudget({ credit: 120, threshold: 20 }, committed, 1, CREDIT_DEFAULTS)).toBe(54);
  });

  test("the card's words", () => {
    const account = { credit: 120, threshold: -0.01 };
    const owed = {
      items: [{ kind: "budget" as const, name: "jtrain2", dollars: 40 }],
      total: 40,
      burn: 1,
    };
    expect(creditLine(account, owed, 72, 1, CREDIT_DEFAULTS)).toBe(
      "Vast credit $120.00 − committed $40.00 (jtrain2: $40.00 left of its budget) − margin $11.20 → covers a budget up to $72.",
    );
    expect(creditLine(account, owed, 80, 1, CREDIT_DEFAULTS, 8)).toBe(
      "Vast credit $120.00 − committed $40.00 (jtrain2: $40.00 left of its budget) − margin $11.20 → covers a budget up to $80 ($8.00 of it spent already).",
    );
    expect(overText(owed, 72)).toBe(
      "More than the credit covers. When the credit reaches $0, Vast stops every box on the account, jtrain2 included. Top up at console.vast.ai → Billing, or keep the budget at $72 or less.",
    );
  });
});

test("runway: hours until the credit reaches the threshold; none while nothing bills", () => {
  expect(runwayHours({ credit: 48, threshold: -0.01 }, 2)).toBe(24);
  expect(runwayHours({ credit: -3, threshold: null }, 2)).toBe(0);
  expect(runwayHours({ credit: 48, threshold: null }, 0)).toBe(Number.POSITIVE_INFINITY);
});
