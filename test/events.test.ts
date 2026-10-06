import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventOfLog,
  eventsPath,
  liveOf,
  Observer,
  readEvents,
  recorder,
  seedFromHostLog,
} from "../events";
import type { Instance } from "../vast-api";

const NOW = 1_791_200_000_000;

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vast-events-"));
}

describe("eventOfLog", () => {
  test("a rent carries its label, budget, lease end and rate", () => {
    expect(
      eventOfLog(
        "rented",
        {
          offer: 9,
          instance: 54,
          label: "jimmy/s-0123abcd/b1",
          budget: 20,
          until: NOW + 1.5,
          rate: 0.4,
        },
        NOW,
      ),
    ).toEqual({
      at: NOW,
      kind: "rented",
      box: 54,
      label: "jimmy/s-0123abcd/b1",
      budget: 20,
      until: NOW + 2,
      rate: 0.4,
    });
  });

  test("a replacement is a rent, an id given as text still counts", () => {
    expect(eventOfLog("replacement_rented", { instance: 7 }, NOW)?.kind).toBe("rented");
    expect(eventOfLog("destroyed", { instance: "8", reason: "budget reached" }, NOW)).toEqual({
      at: NOW,
      kind: "destroyed",
      box: 8,
      reason: "budget reached",
    });
  });

  test("other log lines, and lines without a box, are no events", () => {
    expect(eventOfLog("guard", { instance: 7 }, NOW)).toBeNull();
    expect(eventOfLog("destroyed", { reason: "x" }, NOW)).toBeNull();
    expect(eventOfLog("extended", { instance: "abc" }, NOW)).toBeNull();
  });
});

describe("recorder", () => {
  test("logs as before and appends the events to the history", async () => {
    const path = eventsPath(await folder());
    const logged: string[] = [];
    const log = recorder(
      path,
      (event) => logged.push(event),
      () => NOW,
    );
    log("guard", { instance: 1 });
    log("extended", { instance: 1, until: NOW + 3_600_000, by: "session" });
    await Bun.sleep(20);
    expect(logged).toEqual(["guard", "extended"]);
    expect(await readEvents(path)).toEqual([
      { at: NOW, kind: "extended", box: 1, until: NOW + 3_600_000, by: "session" },
    ]);
  });
});

describe("Observer", () => {
  const box = (id: number, label = ""): Instance => ({
    id,
    label,
    start_date: NOW / 1000 - 60,
    dph_total: 0.5,
  });

  test("a box seen first appears with its start and rate; one no longer listed is gone", async () => {
    const path = eventsPath(await folder());
    const observer = new Observer(path);
    expect(await observer.observe([box(1, "a")], NOW)).toEqual([
      { at: NOW, kind: "appeared", box: 1, label: "a", start: NOW - 60_000, rate: 0.5 },
    ]);
    expect(await observer.observe([box(1, "a")], NOW + 1)).toEqual([]);
    expect(await observer.observe([box(2)], NOW + 2)).toEqual([
      { at: NOW + 2, kind: "appeared", box: 2, label: "", start: NOW - 60_000, rate: 0.5 },
      { at: NOW + 2, kind: "gone", box: 1 },
    ]);
    expect(liveOf(await readEvents(path))).toEqual(new Set([2]));
  });

  test("after a restart, the live boxes are read back from the file", async () => {
    const path = eventsPath(await folder());
    await new Observer(path).observe([box(1)], NOW);
    expect(await new Observer(path).observe([], NOW + 5)).toEqual([
      { at: NOW + 5, kind: "gone", box: 1 },
    ]);
  });
});

describe("seedFromHostLog", () => {
  test("reads this extension's events out of every host log, once", async () => {
    const dir = await folder();
    const logs = join(dir, "logs");
    await Bun.write(
      join(logs, "prifly.1.log"),
      [
        `{"at":"2026-10-05T01:11:03.605Z","level":"info","event":"ext.vastai.rented","offer":3,"instance":54,"label":"jimmy/s-e5636c90/jtrain8","budget":80}`,
        `{"at":"2026-10-05T01:12:00.000Z","level":"info","event":"ext.vastai.guard","instance":54}`,
        `{"at":"2026-10-05T01:13:00.000Z","level":"info","event":"ext.other.destroyed","instance":54}`,
        "not json",
      ].join("\n"),
    );
    await Bun.write(
      join(logs, "prifly.log"),
      `{"at":"2026-10-05T07:04:31.988Z","level":"info","event":"ext.vastai.destroyed","instance":54,"reason":"cancelled"}\n`,
    );
    await writeFile(join(logs, "ui-build.log"), `{"event":"ext.vastai.destroyed","instance":1}`);
    const path = eventsPath(dir);
    expect(await seedFromHostLog(path, logs, "vastai")).toBe(2);
    expect((await readEvents(path)).map((e) => [e.kind, e.box])).toEqual([
      ["rented", 54],
      ["destroyed", 54],
    ]);
    expect(await seedFromHostLog(path, logs, "vastai")).toBe(0);
  });
});
