import { describe, expect, test } from "bun:test";
import type { BoxEvent } from "../events";
import type { Lease } from "../leases";
import { timelineOf } from "../timeline";

const H = 3_600_000;
const T = Date.parse("2026-10-05T12:00:00Z");
const LABEL = "jimmy/s-ae36c18f/abtest3";

describe("timelineOf", () => {
  test("a rented box with an extension that its budget ended", () => {
    const events: BoxEvent[] = [
      { at: T, kind: "appeared", box: 3, label: LABEL, start: T - 60_000, rate: 2 },
      { at: T, kind: "rented", box: 3, label: LABEL, budget: 15, until: T + 2 * H, rate: 2 },
      { at: T + H, kind: "extended", box: 3, until: T + 6 * H, by: "session" },
      { at: T + 5 * H, kind: "destroyed", box: 3, reason: "budget reached" },
    ];
    expect(timelineOf(events, [], [], T - 24 * H, T + 10 * H)).toEqual([
      {
        box: 3,
        label: LABEL,
        start: T - 60_000,
        end: T + 5 * H,
        until: T + 6 * H,
        firstUntil: T + 2 * H,
        budget: 15,
        rate: 2,
        extensions: [{ at: T + H, until: T + 6 * H, hours: 4 }],
        reason: "budget reached",
        by: "extension",
        cost: 2 * (5 + 1 / 60),
      },
    ]);
  });

  test("a box the session cancelled was ended by it; one that vanished is gone from the list", () => {
    const events: BoxEvent[] = [
      { at: T, kind: "rented", box: 1, label: "a" },
      { at: T + H, kind: "cancelled", box: 1 },
      { at: T + H + 60_000, kind: "destroyed", box: 1, reason: "cancelled" },
      { at: T, kind: "appeared", box: 2, label: "b" },
      { at: T + 2 * H, kind: "gone", box: 2 },
    ];
    const [one, two] = timelineOf(events, [], [], 0, T + 3 * H);
    expect([one?.reason, one?.by, one?.end]).toEqual(["cancelled", "session", T + H + 60_000]);
    expect([two?.reason, two?.by, two?.end]).toEqual(["gone from the list", null, T + 2 * H]);
  });

  test("a box listed now runs, its lease from the lease file; a box over before the range is left out", () => {
    const lease: Lease = {
      label: LABEL,
      box: 3,
      bookedAt: T,
      until: T + 8 * H,
      cancelled: false,
      budget: 30,
    };
    const events: BoxEvent[] = [
      { at: T - 48 * H, kind: "appeared", box: 9, label: "old" },
      { at: T - 47 * H, kind: "gone", box: 9 },
      { at: T, kind: "gone", box: 3 },
    ];
    const boxes = timelineOf(
      events,
      [{ id: 3, label: LABEL, start_date: T / 1000, dph_total: 1 }],
      [lease],
      T - 24 * H,
      T + 2 * H,
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ box: 3, end: null, until: T + 8 * H, budget: 30, cost: 2 });
  });
});
