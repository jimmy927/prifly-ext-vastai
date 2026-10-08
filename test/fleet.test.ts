import { describe, expect, test } from "bun:test";
import { boxCards, stateOf } from "../fleet";
import { show } from "../index";
import { GpuHold } from "../load";
import type { Decoration, ExtensionSession } from "../prifly-api";
import type { Instance } from "../vast-api";

const NOW = Date.parse("2026-10-06T11:22:00Z");
const SESSIONS: ExtensionSession[] = [
  { id: "e5636c90-1111", title: "OSS 120B inference", cwd: "/src/odi", state: "idle" },
];
const box = (fields: Partial<Instance>): Instance => ({
  dph_total: 0.5,
  storage_total_cost: 0.02,
  start_date: (NOW - 3_600_000) / 1000,
  ...fields,
});
const deps = {
  owner: "jimmy",
  enforce: false,
  sshKey: null,
  sessions: SESSIONS,
  judged: new Map(),
  hold: new GpuHold(),
  now: NOW,
  claims: new Map<number, string>(),
};

describe("a box's state", () => {
  test("running, starting while its image loads, else only its disk", () => {
    expect(stateOf(box({ actual_status: "running", intended_status: "running" }))).toBe("running");
    expect(stateOf(box({ actual_status: "loading", intended_status: "running" }))).toBe("starting");
    expect(stateOf(box({ actual_status: null, intended_status: "running" }))).toBe("starting");
    expect(stateOf(box({ actual_status: "exited", intended_status: "stopped" }))).toBe("disk");
    expect(stateOf(box({ actual_status: "exited", intended_status: "running" }))).toBe("disk");
  });
});

describe("the cards", () => {
  test("each names its session, running ones first", () => {
    const cards = boxCards(
      [
        box({ id: 1, label: "jimmy/s-e5636c90/aa", actual_status: "exited", disk_space: 40 }),
        box({
          id: 2,
          label: "jimmy/s-e5636c90/zz",
          actual_status: "running",
          ssh_host: "h",
          ssh_port: 22,
        }),
        box({ id: 3, label: "anna/s-12345678/x", actual_status: "running" }),
        box({ id: 4, label: "by-hand", actual_status: "running" }),
      ],
      deps,
    );
    expect(cards.map((c) => [c.name, c.state])).toEqual([
      ["anna/x", "running"],
      ["by-hand", "running"],
      ["zz", "running"],
      ["aa", "disk"],
    ]);
    const zz = cards[2];
    expect(zz?.session).toEqual({
      short: "e5636c90",
      id: "e5636c90-1111",
      title: "OSS 120B inference",
    });
    expect(zz?.ssh).toBe("ssh -o StrictHostKeyChecking=accept-new -p 22 root@h");
    expect(cards[0]?.owner).toEqual({ kind: "foreign", name: "anna" });
    expect(cards[1]?.owner).toEqual({ kind: "none", name: null });
    expect(cards[3]?.diskGb).toBe(40);
  });
});

describe("the status bar", () => {
  test("a box on a known session stays on it; nothing reaches the status bar", () => {
    const shown: { bySession: Record<string, Decoration[]>; unclaimed: Decoration[] } = {
      bySession: {},
      unclaimed: [],
    };
    const api = {
      sessions: () => SESSIONS,
      show: (bySession: Record<string, Decoration[]>, unclaimed: Decoration[]) => {
        shown.bySession = bySession;
        shown.unclaimed = unclaimed;
      },
    };
    show(
      api,
      [
        box({ id: 2, label: "jimmy/s-e5636c90/zz", actual_status: "running", cpu_util: 0 }),
        box({ id: 5, label: "jimmy/s-deadbeef/gone", actual_status: "running", cpu_util: 0 }),
        box({ id: 6, label: "by-hand", actual_status: "running" }),
      ],
      new Map(),
      { owner: "jimmy", enforce: false, sshKey: null },
      new GpuHold(),
      NOW,
    );
    expect(Object.keys(shown.bySession)).toEqual(["e5636c90"]);
    expect(shown.unclaimed).toEqual([]);
  });

  test("the manifest keeps the extension off the status bar", async () => {
    const manifest = await Bun.file(new URL("../prifly-extension.json", import.meta.url)).json();
    expect(manifest.statusBar).toBe(false);
  });
});
