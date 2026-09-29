import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Enforcer } from "../enforce";
import { book, leasesPath, readLeases, updateLeases } from "../leases";
import type { ExtensionApi } from "../prifly-api";
import type { Instance } from "../vast-api";

const NOW = Date.now();
const H = 3_600_000;

/** A fake host: what was said, and a folder of its own. The boxes are not running, so no ssh. */
async function host() {
  const notices: { text: string; session: string | undefined }[] = [];
  const folder = await mkdtemp(join(tmpdir(), "vastai-ext-"));
  const api = {
    folder,
    log: () => undefined,
    notify: (text: string, options?: { session?: string }) =>
      notices.push({ text, session: options?.session }),
  } as unknown as ExtensionApi;
  return { api, folder, notices };
}

const box = (id: number, label: string, startedHoursAgo = 2): Instance => ({
  id,
  label,
  actual_status: "exited",
  start_date: (NOW - startedHoursAgo * H) / 1000,
});

test("with enforcement off, a box without a lease is only said to be due", async () => {
  const { api, notices } = await host();
  const enforcer = new Enforcer(api, { vastai: "false", sshKey: null, enforce: false });
  const judged = await enforcer.round([box(1, "s-0123abcd/lc-box1"), box(2, "lc-box3")], NOW);
  expect(judged.get(1)?.verdict).toEqual({ kind: "due", reason: "no lease" });
  expect(judged.get(2)?.verdict).toEqual({ kind: "unmanaged" });
  expect(notices).toEqual([
    {
      text: "Would destroy lc-box1 (no lease) — lease enforcement is off, so it is left running.",
      session: "0123abcd",
    },
  ]);
  // Said once, not every minute.
  await enforcer.round([box(1, "s-0123abcd/lc-box1")], NOW + 60_000);
  expect(notices).toHaveLength(1);
});

test("a booking binds to its box, and the box then holds the lease", async () => {
  const { api, folder } = await host();
  await updateLeases(leasesPath(folder), (leases) => book(leases, "s-0123abcd/lc-box1", 2, NOW));
  const enforcer = new Enforcer(api, { vastai: "false", sshKey: null, enforce: true });
  const judged = await enforcer.round([box(1, "s-0123abcd/lc-box1", 0)], NOW);
  expect(judged.get(1)?.verdict.kind).toBe("leased");
  expect((await readLeases(leasesPath(folder)))[0]?.box).toBe(1);
});

test("with enforcement on, a due box is destroyed and its lease dropped", async () => {
  const { api, folder, notices } = await host();
  await updateLeases(leasesPath(folder), (leases) =>
    book(leases, "s-0123abcd/lc-box1", 1, NOW - 3 * H),
  );
  // `true` stands in for the CLI: the destroy "succeeds".
  const enforcer = new Enforcer(api, { vastai: "true", sshKey: null, enforce: true });
  const boxes = [box(1, "s-0123abcd/lc-box1")];
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
});
