import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnforceDeps, Enforcer } from "../enforce";
import { book, readLeases, updateLeases } from "../leases";
import type { ExtensionApi } from "../prifly-api";
import { fileStore } from "../store";
import type { Instance } from "../vast-api";

const H = 3_600_000;
const NOW = Date.now();
const SESSION = "0123abcd-1111-2222-3333-444455556666";
const LABEL = "jimmy/s-0123abcd/lc-box1";

/**
 * A due box (three hours past its lease, not running, so no ssh), an enforcer
 * over `deps` with enforcement on, and a way to run one more round and wait for
 * the notice that starts with `prefix`.
 */
async function due(deps: EnforceDeps) {
  const notices: string[] = [];
  const folder = await mkdtemp(join(tmpdir(), "vastai-ext-"));
  const api = {
    folder,
    log: () => undefined,
    notify: (text: string) => notices.push(text),
    sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
  } as unknown as ExtensionApi;
  await updateLeases(fileStore(folder), (leases) => book(leases, LABEL, 1, NOW - 3 * H));
  const enforcer = new Enforcer(
    api,
    fileStore(folder),
    { sshKey: null, enforce: true, owner: "jimmy" },
    { sleep: async () => undefined, ...deps },
  );
  const boxes: Instance[] = [{ id: 1, label: LABEL, actual_status: "exited" }];
  await enforcer.round(boxes, NOW);
  const next = async (prefix: string) => {
    await enforcer.round(boxes, NOW);
    for (let i = 0; i < 50 && !notices.some((n) => n.startsWith(prefix)); i += 1) {
      await Bun.sleep(20);
    }
  };
  return { folder, notices, next };
}

test("a failed destroy is told as failed and tried again the next round", async () => {
  const calls: number[] = [];
  const { folder, notices, next } = await due({
    destroy: async (id) => {
      calls.push(id);
      if (calls.length === 1) throw new Error("Vast.ai destroy of #1 failed (429): too frequent");
    },
  });
  await next("lc-box1 could not be destroyed");
  expect(notices).toContain(
    "lc-box1 could not be destroyed (lease over): Vast.ai destroy of #1 failed (429): too frequent. It is still running and billing. It is tried again within a minute.",
  );
  expect(notices.some((n) => n.startsWith("Destroyed"))).toBe(false);
  expect(await readLeases(fileStore(folder))).toHaveLength(1);
  await next("Destroyed");
  expect(calls).toEqual([1, 1]);
  expect(notices).toContain("Destroyed lc-box1 (lease over); it no longer bills.");
  expect(await readLeases(fileStore(folder))).toEqual([]);
});

test("a box the list still has after the destroy is not told as destroyed", async () => {
  const { folder, notices, next } = await due({
    destroy: async () => undefined,
    isListed: async () => true,
  });
  await next("lc-box1 could not be destroyed");
  expect(notices.join("\n")).toContain("the box was still on its instance list after 2 minutes");
  expect(notices.some((n) => n.startsWith("Destroyed"))).toBe(false);
  expect(await readLeases(fileStore(folder))).toHaveLength(1);
});
