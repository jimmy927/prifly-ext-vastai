import { describe, expect, test } from "bun:test";
import type { Judged } from "../enforce";
import type { Lease } from "../leases";
import { boxActions, leaseLine, providerCard, statusOf } from "../machine-card";
import type { Verdict } from "../rules";

const MIN = 60_000;
const judged = (verdict: Verdict, idleMs = 0, until: number | null = null): Judged => ({
  verdict,
  idleMs,
  until,
  spent: null,
  budget: null,
});
const at = new Date(2026, 8, 30, 14, 30).getTime();
const enabled = (lease: Judged | undefined) =>
  Object.fromEntries(boxActions(1, "b", "$1/h", lease).map((a) => [a.id, a.disabled !== true]));

describe("statusOf", () => {
  test("own leased box, with and without idle", () => {
    const lease = judged({ kind: "leased", leftMs: 100 * MIN }, 0, at);
    expect(statusOf(lease, "2b89f308", "jimmy", true)).toEqual({
      text: "jimmy · session 2b89f308 · leased until 14:30 · 1h 40m left",
    });
    const idle = judged({ kind: "leased", leftMs: 100 * MIN }, 65 * MIN, at);
    expect(statusOf(idle, "2b89f308", "jimmy", true).text).toEndWith("1h 40m left · idle 1h 05m");
  });
  test("ending is a warning; grace, unbooked and due are critical", () => {
    expect(
      statusOf(judged({ kind: "ending", leftMs: 10 * MIN }, 0, at), "aaaaaaaa", "j", true).tone,
    ).toBe("warning");
    for (const verdict of [
      { kind: "grace", leftMs: 5 * MIN },
      { kind: "unbooked", leftMs: 3 * MIN },
      { kind: "due", reason: "no lease" },
    ] as const) {
      expect(statusOf(judged(verdict, 0, at), "aaaaaaaa", "j", true).tone).toBe("critical");
    }
  });
  test("foreign, unmanaged and stranger boxes", () => {
    expect(statusOf(judged({ kind: "foreign", owner: "sam" }), null, "jimmy", true).text).toBe(
      "sam · not managed by this prifly",
    );
    expect(statusOf(judged({ kind: "unmanaged" }), null, "jimmy", true).text).toBe(
      "Not managed by leases: rented by another program",
    );
    expect(
      statusOf(judged({ kind: "stranger", session: "deadbeef" }), "deadbeef", "jimmy", true).text,
    ).toBe("session deadbeef is not this prifly's");
  });
});

describe("actions", () => {
  test("extend is disabled unless the box is managed; destroy never is", () => {
    expect(enabled(judged({ kind: "leased", leftMs: MIN }))).toEqual({
      extend1: true,
      extend4: true,
      destroy: true,
    });
    for (const verdict of [
      { kind: "foreign", owner: "sam" },
      { kind: "unmanaged" },
      { kind: "stranger", session: "deadbeef" },
    ] as const) {
      expect(enabled(judged(verdict))).toEqual({ extend1: false, extend4: false, destroy: true });
    }
    expect(enabled(undefined)["extend1"]).toBe(false);
  });
  test("destroy carries its confirm text", () => {
    const destroy = boxActions(7, "lc-box", "$0.42/h", undefined).find((a) => a.id === "destroy");
    expect(destroy?.confirm).toContain("Destroy lc-box (Vast.ai #7, $0.42/h)");
  });
});

describe("providerCard", () => {
  const lease = (name: string, hours: number): Lease => ({
    label: `jimmy/s-2b89f308/${name}`,
    box: null,
    bookedAt: 0,
    until: hours * 3_600_000,
    cancelled: false,
    budget: null,
  });
  test("lists waiting bookings", () => {
    expect(providerCard([lease("lc-a", 2)]).status?.text).toBe("1 booking waiting: lc-a, 2 h");
    expect(providerCard([lease("lc-a", 2), lease("bf-b", 1.5)]).status?.text).toBe(
      "2 bookings waiting: lc-a, 2 h, bf-b, 1.5 h",
    );
  });
  test("none waiting, and every action disabled", () => {
    const card = providerCard([]);
    expect(card.status?.text).toBe("No bookings waiting");
    expect(card.actions?.map((a) => [a.id, a.disabled])).toEqual([
      ["extend1", true],
      ["extend4", true],
      ["destroy", true],
    ]);
  });
});

describe("the budget in the lease line", () => {
  const withBudget = (verdict: Verdict, spent: number, budget: number): Judged => ({
    ...judged(verdict, 0, at),
    spent,
    budget,
  });

  test("the chip says what the box has cost of its budget", () => {
    const line = leaseLine(withBudget({ kind: "leased", leftMs: 100 * MIN }, 7.4, 20), true);
    expect(line?.short).toBe("1h 40m · $7.40 of $20");
    expect(line?.tone).toBeNull();
    expect(line?.details.some((d) => d.includes("$7.40 of $20"))).toBe(true);
  });

  test("near the budget the chip turns amber", () => {
    const line = leaseLine(withBudget({ kind: "leased", leftMs: 100 * MIN }, 18.5, 20), true);
    expect(line?.tone).toBe("warning");
  });

  test("without a budget the line is as before", () => {
    expect(leaseLine(judged({ kind: "leased", leftMs: 100 * MIN }, 0, at), true)?.short).toBe(
      "1h 40m",
    );
  });

  test("the machine card's status says it too", () => {
    const status = statusOf(
      withBudget({ kind: "leased", leftMs: 100 * MIN }, 7.4, 20),
      "2b89f308",
      "jimmy",
      true,
    );
    expect(status.text).toContain("1h 40m left · $7.40 of $20");
  });
});

test("the provider's card shows the credit, coloured by the runway warnings", () => {
  const view = (runway: number) => ({ credit: 48.62, burn: 1.35, runway, warnHours: [12, 3, 1] });
  expect(providerCard([], view(36)).status).toEqual({
    text: "Credit $48.62 · burn $1.35/h · runway 36h 0m · No bookings waiting",
  });
  expect(providerCard([], view(5)).status?.tone).toBe("warning");
  expect(providerCard([], view(0.5)).status?.tone).toBe("critical");
});
