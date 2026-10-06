import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChargeCache, type ChargeRow, chargesPath } from "../charges";
import { appendEvents, eventsPath } from "../events";
import type { ExtensionSession } from "../prifly-api";
import {
  answer,
  chargeLines,
  describeGroups,
  groupKeyOf,
  nameOfBox,
  type PanelData,
} from "../spend-panel";

const NOW = Date.parse("2026-10-06T11:22:00Z");
const session = (id: string, title: string, cwd: string): ExtensionSession => ({
  id,
  title,
  cwd,
  state: "idle",
});
const SESSIONS = [
  session("e5636c90-1111", "OSS 120B inference cost analysis", "/src/odi.worktrees/cv"),
  session("97f73f94-2222", "investigate-dictation-model", "/src/prifly.worktrees/p121"),
];
const REPOS: Record<string, string> = {
  "/src/odi.worktrees/cv": "artemisrec/odi",
  "/src/prifly.worktrees/p121": "jimmy927/prifly",
};
const repoOf = (cwd: string) => REPOS[cwd] ?? "?";

describe("groups", () => {
  test("a label puts a box with its session, its repository, another owner or none", () => {
    expect(groupKeyOf("jimmy/s-e5636c90/jtrain8", "jimmy")).toBe("s:e5636c90");
    expect(groupKeyOf("s-ce70fdd7/lc-box31", "jimmy")).toBe("s:ce70fdd7");
    expect(groupKeyOf("anna/s-e5636c90/x", "jimmy")).toBe("owner:anna");
    expect(groupKeyOf("project-odi/4b-snap", "jimmy")).toBe("repo:odi");
    expect(groupKeyOf("qwen27b-votes", "jimmy")).toBe("none");
    expect(groupKeyOf("", "jimmy")).toBe("none");
  });

  test("a box goes by its label's name", () => {
    expect(nameOfBox("jimmy/s-e5636c90/jtrain8", 1)).toBe("jtrain8");
    expect(nameOfBox("project-odi/4b-snap", 1)).toBe("4b-snap");
    expect(nameOfBox("rj-reranker:38596:49000", 1)).toBe("rj-reranker:38596:49000");
    expect(nameOfBox("", 54)).toBe("#54");
  });

  test("sessions are found by the start of their id; a project label takes a session's full repository name", () => {
    const groups = describeGroups(
      ["s:e5636c90", "s:7bb478c7", "repo:odi", "repo:other", "none"],
      SESSIONS,
      repoOf,
    );
    expect(groups["s:e5636c90"]).toEqual({
      title: "OSS 120B inference cost analysis",
      repo: "artemisrec/odi",
      kind: "session",
      session: "e5636c90",
    });
    expect(groups["s:7bb478c7"]?.kind).toBe("gone");
    expect(groups["repo:odi"]?.repo).toBe("artemisrec/odi");
    expect(groups["repo:other"]?.repo).toBe("other");
    expect(groups["none"]?.kind).toBe("none");
  });

  test("charge lines carry their group and box name, and leave out what cost nothing", () => {
    const rows = new Map<string, ChargeRow[]>([
      [
        "2026-10-05",
        [
          { box: 1, label: "jimmy/s-e5636c90/jtrain8", kind: "instance", amount: 63.748 },
          { box: 2, label: "rj-reranker", kind: "instance", amount: 0 },
        ],
      ],
    ]);
    expect(chargeLines(rows, "jimmy")).toEqual([
      { day: "2026-10-05", group: "s:e5636c90", box: 1, name: "jtrain8", amount: 63.748 },
    ]);
  });
});

describe("answer", () => {
  test("api/data: charges, groups, the timeline and what bills now", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vast-panel-"));
    await appendEvents(eventsPath(folder), [
      {
        at: NOW - 3_600_000,
        kind: "rented",
        box: 5,
        label: "jimmy/s-97f73f94/dictbase",
        budget: 3,
      },
    ]);
    const asked: string[] = [];
    const deps = {
      folder,
      owner: "jimmy",
      sessions: () => SESSIONS,
      charges: new ChargeCache(chargesPath(folder), async (day) => {
        asked.push(day);
        return [{ box: 5, label: "jimmy/s-97f73f94/dictbase", kind: "instance", amount: 1 }];
      }),
      listed: () => [
        {
          id: 5,
          label: "jimmy/s-97f73f94/dictbase",
          actual_status: "running",
          dph_total: 0.1,
          start_date: (NOW - 3_600_000) / 1000,
        },
      ],
      now: () => NOW,
    };
    const data = (await answer(deps, {
      path: "data",
      query: { days: "7" },
      body: null,
    })) as PanelData;
    expect(data.days).toHaveLength(7);
    expect(asked).toHaveLength(7);
    expect(data.charges).toHaveLength(7);
    expect(Object.keys(data.groups)).toEqual(["s:97f73f94"]);
    expect(data.boxes).toHaveLength(1);
    expect(data.boxes[0]).toMatchObject({
      name: "dictbase",
      group: "s:97f73f94",
      end: null,
      budget: 3,
    });
    expect(data.live).toEqual({ burn: 0.1, names: ["dictbase"] });
    expect(data.historyFrom).toBe(NOW - 3_600_000);
    expect(() => answer(deps, { path: "nope", query: {}, body: null })).toThrow("No such request");
  });

  test("a box the history knows only by its id takes its label from its charges", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vast-panel-"));
    await appendEvents(eventsPath(folder), [
      { at: NOW - 3_600_000, kind: "destroyed", box: 8, reason: "the host's end date is near" },
    ]);
    const deps = {
      folder,
      owner: "jimmy",
      sessions: () => SESSIONS,
      charges: new ChargeCache(chargesPath(folder), async () => [
        { box: 8, label: "jimmy/s-e5636c90/jtrain", kind: "instance", amount: 8.79 },
      ]),
      listed: () => [],
      now: () => NOW,
    };
    const data = (await answer(deps, {
      path: "data",
      query: { days: "1" },
      body: null,
    })) as PanelData;
    expect(data.boxes[0]).toMatchObject({ box: 8, name: "jtrain", group: "s:e5636c90" });
  });
});
