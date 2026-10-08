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
  const sessions: ExtensionSession[] = [
    ...SESSIONS,
    { id: "0ddba11c-2222", title: "Finished job", cwd: "/src/odi", state: "ended" },
  ];
  const shownFor = (boxes: Instance[]) => {
    const shown: { bySession: Record<string, Decoration[]>; statusBar: Decoration[] } = {
      bySession: {},
      statusBar: [],
    };
    const api = {
      sessions: () => sessions,
      show: (bySession: Record<string, Decoration[]>, statusBar: Decoration[]) => {
        shown.bySession = bySession;
        shown.statusBar = statusBar;
      },
    };
    show(
      api,
      boxes,
      new Map(),
      { owner: "jimmy", enforce: false, sshKey: null },
      new GpuHold(),
      NOW,
    );
    return shown;
  };

  test("a running box on a live session is on its banner only", () => {
    const shown = shownFor([
      box({ id: 2, label: "jimmy/s-e5636c90/zz", actual_status: "running", cpu_util: 0 }),
    ]);
    expect(Object.keys(shown.bySession)).toEqual(["e5636c90"]);
    expect(shown.statusBar).toEqual([]);
  });

  test("a running box on an ended session is in the status bar", () => {
    const shown = shownFor([
      box({ id: 3, label: "jimmy/s-0ddba11c/old", actual_status: "running", cpu_util: 0 }),
    ]);
    expect(shown.bySession).toEqual({});
    expect(shown.statusBar.map((d) => d.key)).toEqual(["3"]);
  });

  test("a running box whose session is unknown is in the status bar", () => {
    const shown = shownFor([
      box({ id: 5, label: "jimmy/s-deadbeef/gone", actual_status: "running", cpu_util: 0 }),
    ]);
    expect(shown.bySession).toEqual({});
    expect(shown.statusBar.map((d) => d.key)).toEqual(["5"]);
  });

  test("a running box rented by hand is in the status bar", () => {
    const shown = shownFor([box({ id: 6, label: "by-hand", actual_status: "running" })]);
    expect(shown.bySession).toEqual({});
    expect(shown.statusBar.map((d) => d.key)).toEqual(["6"]);
  });

  test("a stopped box on no live session is in neither", () => {
    const shown = shownFor([
      box({ id: 7, label: "jimmy/s-0ddba11c/disk", actual_status: "exited" }),
      box({ id: 8, label: "by-hand-disk", actual_status: "exited" }),
    ]);
    expect(shown.bySession).toEqual({});
    expect(shown.statusBar).toEqual([]);
  });

  test("the manifest no longer sets statusBar", async () => {
    const manifest = await Bun.file(new URL("../prifly-extension.json", import.meta.url)).json();
    expect("statusBar" in manifest).toBe(false);
  });
});
