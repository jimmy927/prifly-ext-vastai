import { expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Enforcer } from "../enforce";
import { book, leasesPath, readLeases, updateLeases } from "../leases";
import type { ExtensionApi } from "../prifly-api";
import type { Instance } from "../vast-api";

const NOW = Date.now();
const H = 3_600_000;

const SESSION = "0123abcd-1111-2222-3333-444455556666";

/**
 * A fake host: what was said, a folder of its own, and one session it knows.
 * The boxes are not running, so no ssh.
 */
async function host() {
  const notices: { text: string; session: string | undefined }[] = [];
  const folder = await mkdtemp(join(tmpdir(), "vastai-ext-"));
  const api = {
    folder,
    log: () => undefined,
    notify: (text: string, options?: { session?: string }) =>
      notices.push({ text, session: options?.session }),
    sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
  } as unknown as ExtensionApi;
  return { api, folder, notices };
}

/** A stand-in for the `vastai` CLI that only writes down each call: nothing real is destroyed. */
async function fakeCli(folder: string): Promise<{ path: string; calls: () => Promise<string> }> {
  const path = join(folder, "fake-vastai");
  const log = join(folder, "fake-vastai.log");
  await Bun.write(path, `#!/bin/sh\necho "$@" >> '${log}'\n`);
  await chmod(path, 0o755);
  const calls = async () => ((await Bun.file(log).exists()) ? Bun.file(log).text() : "");
  return { path, calls };
}

const config = (vastai: string, enforce: boolean) => ({
  vastai,
  sshKey: null,
  enforce,
  owner: "jimmy",
});

const box = (id: number, label: string, startedHoursAgo = 2): Instance => ({
  id,
  label,
  actual_status: "exited",
  start_date: (NOW - startedHoursAgo * H) / 1000,
});

test("with enforcement off, a box without a lease is only said to be due", async () => {
  const { api, notices } = await host();
  const enforcer = new Enforcer(api, config("false", false));
  const judged = await enforcer.round([box(1, "jimmy/s-0123abcd/lc-box1"), box(2, "lc-box3")], NOW);
  expect(judged.get(1)?.verdict).toEqual({ kind: "due", reason: "no lease" });
  expect(judged.get(2)?.verdict).toEqual({ kind: "unmanaged" });
  expect(notices).toEqual([
    {
      text: "Would destroy lc-box1 (no lease) — lease enforcement is off, so it is left running.",
      session: "0123abcd",
    },
  ]);
  // Said once, not every minute.
  await enforcer.round([box(1, "jimmy/s-0123abcd/lc-box1")], NOW + 60_000);
  expect(notices).toHaveLength(1);
});

test("a booking binds to its box, and the box then holds the lease", async () => {
  const { api, folder } = await host();
  await updateLeases(leasesPath(folder), (leases) =>
    book(leases, "jimmy/s-0123abcd/lc-box1", 2, NOW),
  );
  const enforcer = new Enforcer(api, config("false", true));
  const judged = await enforcer.round([box(1, "jimmy/s-0123abcd/lc-box1", 0)], NOW);
  expect(judged.get(1)?.verdict.kind).toBe("leased");
  expect((await readLeases(leasesPath(folder)))[0]?.box).toBe(1);
});

test("with enforcement on, a due box is destroyed and its lease dropped", async () => {
  const { api, folder, notices } = await host();
  await updateLeases(leasesPath(folder), (leases) =>
    book(leases, "jimmy/s-0123abcd/lc-box1", 1, NOW - 3 * H),
  );
  const cli = await fakeCli(folder);
  const enforcer = new Enforcer(api, config(cli.path, true));
  const boxes = [box(1, "jimmy/s-0123abcd/lc-box1")];
  await enforcer.round(boxes, NOW);
  // Bound now, and over by two hours: due. The take-down runs in the background.
  await enforcer.round(boxes, NOW);
  for (let i = 0; i < 50 && !notices.some((n) => n.text.startsWith("Destroyed")); i += 1) {
    await Bun.sleep(20);
  }
  expect(notices.map((n) => n.text)).toContain(
    "Destroyed lc-box1 (lease over); it no longer bills.",
  );
  expect(await readLeases(leasesPath(folder))).toEqual([]);
  expect(await cli.calls()).toBe("destroy instance 1 -y\n");
});

test("the older label is still this owner's, and is enforced", async () => {
  const { api, notices } = await host();
  const enforcer = new Enforcer(api, config("false", false));
  const judged = await enforcer.round([box(1, "s-0123abcd/lc-box1")], NOW);
  expect(judged.get(1)?.verdict).toEqual({ kind: "due", reason: "no lease" });
  expect(notices.map((n) => n.text)).toEqual([
    "Would destroy lc-box1 (no lease) — lease enforcement is off, so it is left running.",
  ]);
});

test("another owner's box and an unknown session's box are never destroyed", async () => {
  const { api, folder, notices } = await host();
  // Leases that would be long over, had these boxes been this prifly's.
  await updateLeases(leasesPath(folder), (leases) => ({
    leases: [
      ...book(leases, "anna/s-0123abcd/lc-box1", 1, NOW - 3 * H).leases,
      ...book([], "jimmy/s-99999999/lc-box2", 1, NOW - 3 * H).leases,
    ],
    result: null,
  }));
  const cli = await fakeCli(folder);
  const enforcer = new Enforcer(api, config(cli.path, true));
  const boxes = [box(1, "anna/s-0123abcd/lc-box1"), box(2, "jimmy/s-99999999/lc-box2")];
  for (let round = 0; round < 3; round += 1) {
    const judged = await enforcer.round(boxes, NOW + round * 60_000);
    expect(judged.get(1)?.verdict).toEqual({ kind: "foreign", owner: "anna" });
    expect(judged.get(2)?.verdict).toEqual({ kind: "stranger", session: "99999999" });
  }
  await Bun.sleep(100);
  expect(await cli.calls()).toBe("");
  // The stranger is warned about once; the other owner's box is not this prifly's to mention.
  expect(notices).toEqual([
    {
      text: "lc-box2 is labelled for session 99999999, which is not this prifly's session: it is never destroyed here.",
      session: undefined,
    },
  ]);
});
