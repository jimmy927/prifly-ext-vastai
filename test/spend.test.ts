import { describe, expect, test } from "bun:test";
import { budgetEnd, cappedUntil, costAt, dollars, spentLine, spentOf } from "../spend";
import type { Instance } from "../vast-api";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const box = (hoursAgo: number, rate: number): Instance => ({
  id: 1,
  dph_total: rate,
  start_date: (NOW - hoursAgo * H) / 1000,
});

describe("spentOf", () => {
  test("is the hourly rate times the hours since the box started", () => {
    expect(spentOf(box(1.5, 2), NOW)).toBeCloseTo(3, 9);
    expect(spentOf(box(0, 2), NOW)).toBe(0);
  });

  test("is null when Vast.ai did not say when it started or what it costs", () => {
    expect(spentOf({ id: 1, dph_total: 1 }, NOW)).toBeNull();
    expect(spentOf({ id: 1, start_date: NOW / 1000 }, NOW)).toBeNull();
  });

  test("never goes negative when the clocks disagree", () => {
    expect(spentOf(box(-1, 2), NOW)).toBe(0);
  });

  test("costAt looks ahead", () => {
    expect(costAt(box(1, 2), NOW + 4 * H)).toBeCloseTo(10, 9);
  });
});

describe("the hour the budget runs out", () => {
  test("budgetEnd is the start plus budget over rate", () => {
    expect(budgetEnd(box(1, 2), 10)).toBeCloseTo(NOW - H + 5 * H, 0);
    expect(budgetEnd(box(1, 0), 10)).toBeNull();
    expect(budgetEnd({ id: 1 }, 10)).toBeNull();
  });

  test("a lease's end is held to it, and left alone without a budget or when earlier", () => {
    const b = box(1, 2);
    const end = NOW + 4 * H;
    expect(cappedUntil(NOW + 10 * H, b, 10)).toBe(end);
    expect(cappedUntil(NOW + 2 * H, b, 10)).toBe(NOW + 2 * H);
    expect(cappedUntil(NOW + 10 * H, b, null)).toBe(NOW + 10 * H);
  });
});

describe("money in words", () => {
  test("cents for what was spent, whole dollars for a whole budget", () => {
    expect(dollars(7.4)).toBe("$7.40");
    expect(spentLine(7.4, 20)).toBe("$7.40 of $20");
    expect(spentLine(1, 12.5)).toBe("$1.00 of $12.50");
  });
});
