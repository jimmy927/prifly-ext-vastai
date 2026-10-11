import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChargeCache,
  type ChargeRow,
  dayOf,
  fetchDay,
  isStale,
  lastDays,
  parseChargePage,
} from "../charges";
import { fileStore } from "../store";
import type { Fetch } from "../vast-api";

const H = 3_600_000;
const NOW = Date.parse("2026-10-06T11:22:00Z");

describe("parseChargePage", () => {
  test("reads a box's id, label, kind and amount; other kinds have no box", () => {
    expect(
      parseChargePage({
        results: [
          {
            type: "instance",
            source: "instance-54305134",
            amount: 1.332,
            metadata: { label: "jimmy/s-97f73f94/dictbase" },
            items: [],
          },
          { type: "volume", source: "volume-9", amount: 0.1, metadata: {} },
          { nonsense: true },
        ],
        next_token: "",
      }),
    ).toEqual({
      rows: [
        { box: 54305134, label: "jimmy/s-97f73f94/dictbase", kind: "instance", amount: 1.332 },
        { box: null, label: "", kind: "volume", amount: 0.1 },
      ],
      next: null,
    });
  });
});

describe("days", () => {
  test("the last days are UTC days, today last", () => {
    expect(lastDays(3, NOW)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
    expect(dayOf(Date.parse("2026-10-05T23:59:59Z"))).toBe("2026-10-05");
  });

  test("a day is asked again until a day after it ended, at most every ten minutes", () => {
    const end = Date.parse("2026-10-06T00:00:00Z");
    expect(isStale("2026-10-05", end - H, end + H)).toBe(true);
    expect(isStale("2026-10-05", end + H, end + H + 60_000)).toBe(false);
    expect(isStale("2026-10-05", end + 25 * H, end + 48 * H)).toBe(false);
  });
});

describe("fetchDay", () => {
  test("asks one UTC day, follows the pages, and keeps the trailing slash", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      const after = new URL(url).searchParams.get("after_token");
      const page =
        after === null
          ? { results: [{ type: "instance", source: "instance-1", amount: 1 }], next_token: "t2" }
          : { results: [{ type: "instance", source: "instance-2", amount: 2 }], next_token: null };
      return Response.json(page);
    };
    const rows = await fetchDay("k", "2026-10-05", get);
    expect(rows.map((r) => r.box)).toEqual([1, 2]);
    const first = new URL(asked[0] ?? "");
    expect(first.pathname).toBe("/api/v0/charges/");
    const from = Date.parse("2026-10-05T00:00:00Z") / 1000;
    expect(JSON.parse(first.searchParams.get("select_filters") ?? "")).toEqual({
      day: { gte: from, lte: from + 86_399 },
    });
  });

  test("waits out a 429 and asks again", async () => {
    const waits: number[] = [];
    let calls = 0;
    const get: Fetch = async () => {
      calls += 1;
      return calls < 3
        ? Response.json({ msg: "API requests too frequent" }, { status: 429 })
        : Response.json({ results: [], next_token: null });
    };
    expect(await fetchDay("k", "2026-10-05", get, async (ms) => waits.push(ms))).toEqual([]);
    expect(waits).toEqual([1000, 2000]);
  });

  test("a refused key fails as a refusal", async () => {
    const get: Fetch = async () => Response.json({ msg: "bad key" }, { status: 401 });
    await expect(fetchDay("k", "2026-10-05", get)).rejects.toThrow("bad key");
  });
});

describe("ChargeCache", () => {
  const row = (amount: number): ChargeRow => ({ box: 1, label: "a", kind: "instance", amount });

  test("asks each day once, keeps it, and asks a settling day again later", async () => {
    const store = fileStore(await mkdtemp(join(tmpdir(), "vast-charges-")));
    const asked: string[] = [];
    const cache = new ChargeCache(store, async (day) => {
      asked.push(day);
      return [row(asked.length)];
    });
    const days = ["2026-10-01", "2026-10-06"];
    const first = await cache.days(days, NOW);
    expect(asked).toEqual(days);
    expect(first.rows.get("2026-10-06")).toEqual([row(2)]);
    await cache.days(days, NOW + 60_000);
    expect(asked).toHaveLength(2);
    // A new cache reads the file: only today is still settling.
    const again = new ChargeCache(store, async (day) => {
      asked.push(day);
      return [row(9)];
    });
    const later = await again.days(days, NOW + H);
    expect(asked.slice(2)).toEqual(["2026-10-06"]);
    expect(later.rows.get("2026-10-01")).toEqual([row(1)]);
    expect(later.rows.get("2026-10-06")).toEqual([row(9)]);
  });

  test("a day Vast.ai does not answer for is named, and the others still come", async () => {
    const store = fileStore(await mkdtemp(join(tmpdir(), "vast-charges-")));
    const cache = new ChargeCache(store, async (day) => {
      if (day === "2026-10-05") throw new Error("offline");
      return [row(1)];
    });
    const { rows, failed } = await cache.days(["2026-10-05", "2026-10-06"], NOW);
    expect(failed).toEqual(["2026-10-05"]);
    expect([...rows.keys()]).toEqual(["2026-10-06"]);
  });
});
