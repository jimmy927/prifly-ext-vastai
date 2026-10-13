import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CampaignWatch,
  DEFAULT_SAVE,
  destOf,
  type PullDeps,
  type Pulled,
  pullSaves,
} from "../campaign";
import { type EnforceDeps, Enforcer } from "../enforce";
import { book, cancel, readLeases, updateLeases } from "../leases";
import type { CampaignHold, ExtensionApi } from "../prifly-api";
import type { Route } from "../run";
import { fileStore } from "../store";
import type { Instance } from "../vast-api";

const NOW = Date.now();
const H = 3_600_000;
const SESSION = "0123abcd-1111-2222-3333-444455556666";
const LABEL = "jimmy/s-0123abcd/lc-box1";
const HOLD: CampaignHold = {
  machineKey: "1",
  leadSession: "lead-session-id",
  save: [],
  reason: "lc-eval",
};

/** A running box at $1/h that started two hours ago, so it has cost about $2. */
const running = (): Instance => ({
  id: 1,
  label: LABEL,
  actual_status: "running",
  start_date: (NOW - 2 * H) / 1000,
  dph_total: 1,
  ssh_host: "ssh1.vast.ai",
  ssh_port: 20001,
});

type Rig = {
  api: ExtensionApi;
  folder: string;
  holds: CampaignHold[];
  prompts: { session: string; text: string }[];
  logs: { event: string; fields: Record<string, unknown> | undefined }[];
  notices: string[];
  events: string[];
  deps: EnforceDeps;
  pulls: { globs: readonly string[]; dest: string }[];
};

/** A fake host with campaigns (`withCampaigns`) or without, and fakes for ssh, pull and destroy. */
async function rig(options: {
  withCampaigns: boolean;
  pull?: () => Promise<Pulled>;
  save?: string;
}) {
  const folder = await mkdtemp(join(tmpdir(), "vastai-campaign-"));
  const holds: CampaignHold[] = [];
  const prompts: Rig["prompts"] = [];
  const logs: Rig["logs"] = [];
  const notices: string[] = [];
  const events: string[] = [];
  const pulls: Rig["pulls"] = [];
  const api = {
    folder,
    log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields }),
    notify: (text: string) => notices.push(text),
    sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
    prompt: async (session: string, text: string) => {
      prompts.push({ session, text });
      return { delivered: true };
    },
    ...(options.withCampaigns ? { campaigns: { holds: () => holds } } : {}),
  } as unknown as ExtensionApi;
  const deps: EnforceDeps = {
    destroy: async () => {
      events.push("destroy");
    },
    onBox: async () => ({ code: 0, out: options.save ?? "", err: "" }),
    sleep: async () => undefined,
    pull: async (_routes, globs, dest) => {
      events.push("pull");
      pulls.push({ globs, dest });
      return options.pull === undefined
        ? { ok: true, files: 3, dest, error: "" }
        : await options.pull();
    },
  };
  return { api, folder, holds, prompts, logs, notices, events, deps, pulls } satisfies Rig;
}

const config = { sshKey: null, enforce: true, owner: "jimmy" };

async function booked(folder: string, hours: number, budget: number | null) {
  await updateLeases(fileStore(folder), (leases) => book(leases, LABEL, hours, NOW, budget));
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i += 1) await Bun.sleep(10);
}

describe("a held box's lease", () => {
  test("is extended when the budget allows, and the lead is not woken", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push(HOLD);
    await booked(r.folder, 1, 40);
    const enforcer = new Enforcer(r.api, fileStore(r.folder), config, r.deps);
    const judged = await enforcer.round([running()], NOW);
    const [lease] = await readLeases(fileStore(r.folder));
    expect(lease?.until).toBe(NOW + 9 * H);
    expect(judged.get(1)?.until).toBe(NOW + 9 * H);
    const extended = r.logs.find((l) => l.event === "extended");
    expect(extended?.fields).toMatchObject({ instance: 1, by: "campaign" });
    expect(r.prompts).toEqual([]);
  });

  test("is only extended as far as the budget reaches, never past the host's end date", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push(HOLD);
    await booked(r.folder, 1, 40);
    const box = { ...running(), end_date: (NOW + 4 * H) / 1000 };
    await new Enforcer(r.api, fileStore(r.folder), config, r.deps).round([box], NOW);
    const [lease] = await readLeases(fileStore(r.folder));
    // 30 minutes before the host's end date, as vast_extend holds it.
    expect(lease?.until).toBe(NOW + 3.5 * H);
  });

  test("the lead is woken once, an hour before the end, when the budget does not allow more", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push({ ...HOLD, save: ["/root/work/out/*.json"] });
    // $2.50 at $1/h from two hours ago: the budget runs out in 30 minutes.
    await booked(r.folder, 1.5, 2.5);
    const enforcer = new Enforcer(r.api, fileStore(r.folder), config, r.deps);
    await enforcer.round([running()], NOW);
    await enforcer.round([running()], NOW + 60_000);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]?.session).toBe("lead-session-id");
    const text = r.prompts[0]?.text ?? "";
    expect(text).toContain("lc-box1");
    expect(text).toContain("30m");
    expect(text).toContain("/root/work/out/*.json");
    expect(r.logs.some((l) => l.event === "extended")).toBe(false);
  });

  test("a wake the host did not deliver is tried again on the next tick", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push(HOLD);
    await booked(r.folder, 1.5, 2.5);
    let delivered = false;
    const api = {
      ...r.api,
      prompt: async (session: string, text: string) => {
        r.prompts.push({ session, text });
        const answer = { delivered };
        delivered = true;
        return answer;
      },
    } as ExtensionApi;
    const enforcer = new Enforcer(api, fileStore(r.folder), config, r.deps);
    await enforcer.round([running()], NOW);
    await enforcer.round([running()], NOW + 60_000);
    await enforcer.round([running()], NOW + 120_000);
    expect(r.prompts).toHaveLength(2);
    expect(r.logs.filter((l) => l.event === "campaign_woke")).toHaveLength(1);
    expect(r.logs.some((l) => l.event === "campaign_wake_failed")).toBe(true);
  });

  test("a lease that still has hours and a budget that covers them wakes nobody", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push(HOLD);
    await booked(r.folder, 5, 40);
    await new Enforcer(r.api, fileStore(r.folder), config, r.deps).round([running()], NOW);
    expect(r.prompts).toEqual([]);
    expect(r.logs.some((l) => l.event === "extended")).toBe(false);
  });
});

describe("before a held box is destroyed", () => {
  /** Hold, book, cancel and run the two rounds that bind and then take the box down. */
  async function takeDown(r: Awaited<ReturnType<typeof rig>>, settleOn = "destroy") {
    const store = fileStore(r.folder);
    await booked(r.folder, 5, 40);
    const enforcer = new Enforcer(r.api, store, config, r.deps);
    await enforcer.round([running()], NOW);
    await updateLeases(store, (leases) => cancel(leases, { label: LABEL }));
    await enforcer.round([running()], NOW);
    await settle(() => r.events.includes(settleOn));
    await settle(() => r.notices.some((n) => n.startsWith("Destroyed")));
  }

  test("its results are pulled first, and the notice says how many files and where", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push(HOLD);
    await takeDown(r);
    expect(r.events).toEqual(["pull", "destroy"]);
    expect(r.pulls[0]?.globs).toEqual(DEFAULT_SAVE);
    expect(r.pulls[0]?.dest).toBe(destOf("lc-box1"));
    expect(r.notices.find((n) => n.startsWith("Destroyed"))).toContain(
      `Copied 3 file(s) to ${destOf("lc-box1")}.`,
    );
    const pulled = r.logs.find((l) => l.event === "pulled");
    expect(pulled?.fields).toMatchObject({ ok: true, files: 3, attempt: 1 });
  });

  test("the box is destroyed after two failed pulls, and the notice says the copy failed", async () => {
    const r = await rig({
      withCampaigns: true,
      pull: async () => ({ ok: false, files: 0, dest: "/d", error: "ssh refused" }),
    });
    r.holds.push(HOLD);
    await takeDown(r);
    expect(r.events).toEqual(["pull", "pull", "destroy"]);
    expect(r.notices.find((n) => n.startsWith("Destroyed"))).toContain("failed (ssh refused)");
  });

  test("a pull that throws counts as a failed attempt, and the box is destroyed after two", async () => {
    let calls = 0;
    const r = await rig({
      withCampaigns: true,
      pull: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    r.holds.push(HOLD);
    await takeDown(r);
    expect(calls).toBe(2);
    expect(r.events).toEqual(["pull", "pull", "destroy"]);
    expect(r.notices.find((n) => n.startsWith("Destroyed"))).toContain("failed (boom)");
  });

  test("a box whose hold just ended is still covered, with the last hold's globs", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push({ ...HOLD, save: ["/root/work/out/*.json"] });
    const store = fileStore(r.folder);
    await booked(r.folder, 5, 40);
    const enforcer = new Enforcer(r.api, store, config, r.deps);
    await enforcer.round([running()], NOW);
    r.holds.length = 0;
    await updateLeases(store, (leases) => cancel(leases, { label: LABEL }));
    await enforcer.round([running()], NOW);
    await settle(() => r.events.includes("destroy"));
    expect(r.events).toEqual(["pull", "destroy"]);
    expect(r.pulls[0]?.globs).toEqual(["/root/work/out/*.json"]);
  });

  test("a box no campaign ever held is destroyed without a pull", async () => {
    const r = await rig({ withCampaigns: true });
    await takeDown(r);
    expect(r.events).toEqual(["destroy"]);
  });
});

describe("without api.campaigns", () => {
  test("nothing is held: no extension, no wake, no pull, the notice as before", async () => {
    const r = await rig({ withCampaigns: false });
    await booked(r.folder, 1, 2.5);
    const store = fileStore(r.folder);
    const enforcer = new Enforcer(r.api, store, config, r.deps);
    await enforcer.round([running()], NOW);
    await updateLeases(store, (leases) => cancel(leases, { label: LABEL }));
    await enforcer.round([running()], NOW);
    await settle(() => r.notices.some((n) => n.startsWith("Destroyed")));
    expect(r.prompts).toEqual([]);
    expect(r.events).toEqual(["destroy"]);
    expect(r.logs.some((l) => l.event === "extended" || l.event === "pulled")).toBe(false);
    expect(await Bun.file(join(r.folder, "holds.json")).exists()).toBe(false);
    expect(r.notices.find((n) => n.startsWith("Destroyed"))).toBe(
      "Destroyed lc-box1 (cancelled); it no longer bills.",
    );
  });

  test("the watch holds nothing", async () => {
    const r = await rig({ withCampaigns: false });
    expect(new CampaignWatch(r.api, fileStore(r.folder)).holds().size).toBe(0);
  });
});

describe("the save log", () => {
  async function saved(save: string) {
    const r = await rig({ withCampaigns: false, save });
    const store = fileStore(r.folder);
    await booked(r.folder, 5, 40);
    const enforcer = new Enforcer(r.api, store, config, r.deps);
    await enforcer.round([running()], NOW);
    await updateLeases(store, (leases) => cancel(leases, { label: LABEL }));
    await enforcer.round([running()], NOW);
    await settle(() => r.notices.some((n) => n.startsWith("Destroyed")));
    return r;
  }

  test("a box with no save script logs hook false and the notice says so", async () => {
    const r = await saved("no-save-script\n");
    expect(r.logs.find((l) => l.event === "saved")?.fields).toMatchObject({ code: 0, hook: false });
    expect(r.notices.find((n) => n.startsWith("Destroyed"))).toBe(
      "Destroyed lc-box1 (cancelled); it no longer bills. It had no save script.",
    );
  });

  test("a save script that ran logs hook true", async () => {
    const r = await saved("");
    expect(r.logs.find((l) => l.event === "saved")?.fields).toMatchObject({ code: 0, hook: true });
    expect(r.notices.find((n) => n.startsWith("Destroyed"))).not.toContain("no save script");
  });
});

describe("pullSaves", () => {
  const routes: Route[] = [
    { label: "direct", exec: ["ssh", "-i", "/k key", "-p", "41022", "root@203.0.113.9"] },
    { label: "proxy", exec: ["ssh", "-i", "/k key", "-p", "19928", "root@ssh9.vast.ai"] },
  ];

  /** A box whose `/root/work/run` holds two runs; `copy` decides how each rsync ends. */
  function fakes(copy: (argv: string[]) => number) {
    const spawned: { argv: string[]; stdin: string }[] = [];
    const made: string[] = [];
    const deps: PullDeps = {
      list: async (_routes, command) => ({
        code: 0,
        out: command.includes("best.*")
          ? "/root/work/run/a/best.pt\n/root/work/run/b/best.pt\n"
          : "",
        err: "",
      }),
      spawn: async (argv, stdin) => {
        spawned.push({ argv, stdin });
        return { code: copy(argv), out: "", err: "" };
      },
      mkdir: async (path) => {
        made.push(path);
      },
    };
    return { deps, spawned, made };
  }

  test("copies what the globs match with rsync over the first route, keeping the run folders", async () => {
    const f = fakes(() => 0);
    const pulled = await pullSaves(routes, DEFAULT_SAVE, "/h/lc-runs/lc-box1", f.deps);
    expect(pulled).toEqual({ ok: true, files: 2, dest: "/h/lc-runs/lc-box1", error: "" });
    expect(f.made).toEqual(["/h/lc-runs/lc-box1"]);
    // Only the glob with matches is copied: the other two matched nothing.
    expect(f.spawned).toHaveLength(1);
    const { argv, stdin } = f.spawned[0] ?? { argv: [], stdin: "" };
    expect(argv[0]).toBe("rsync");
    expect(argv).toContain("--files-from=-");
    expect(argv[argv.indexOf("-e") + 1]).toContain("-p 41022");
    expect(argv[argv.indexOf("-e") + 1]).toContain("'/k key'");
    expect(argv[argv.indexOf("-e") + 1]).not.toContain("root@");
    expect(argv).toContain("root@203.0.113.9:/root/work/run/");
    expect(stdin).toBe("a/best.pt\nb/best.pt");
  });

  test("falls back to the proxy only when ssh could not connect", async () => {
    const f = fakes((argv) => (argv.join(" ").includes("41022") ? 255 : 0));
    expect((await pullSaves(routes, [DEFAULT_SAVE[0] ?? ""], "/d", f.deps)).ok).toBe(true);
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[1]?.argv).toContain("root@ssh9.vast.ai:/root/work/run/");
    const failing = fakes(() => 23);
    const failed = await pullSaves(routes, [DEFAULT_SAVE[0] ?? ""], "/d", failing.deps);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("rsync exit 23");
    expect(failing.spawned).toHaveLength(1);
  });

  test("a glob a remote shell would take for a command is refused, not run", async () => {
    const f = fakes(() => 0);
    const pulled = await pullSaves(routes, ["/root/x; rm -rf /"], "/d", f.deps);
    expect(pulled.ok).toBe(false);
    expect(pulled.error).toContain("not a plain absolute glob");
    expect(f.spawned).toEqual([]);
  });

  test("a box that cannot be asked fails the pull", async () => {
    const f = fakes(() => 0);
    f.deps.list = async () => ({ code: 255, out: "", err: "connection refused" });
    const pulled = await pullSaves(routes, DEFAULT_SAVE, "/d", f.deps);
    expect(pulled.ok).toBe(false);
    expect(pulled.error).toContain("connection refused");
  });
});

describe("what a hold remembers", () => {
  test("a hold older than a day no longer covers the box", async () => {
    const r = await rig({ withCampaigns: true });
    r.holds.push(HOLD);
    const watch = new CampaignWatch(r.api, fileStore(r.folder));
    await watch.track([running()], new Map([["1", HOLD]]), NOW);
    r.holds.length = 0;
    expect((await watch.coverOf(1, LABEL, "lc-box1", NOW + 23 * H))?.globs).toEqual(DEFAULT_SAVE);
    expect(await watch.coverOf(1, LABEL, "lc-box1", NOW + 25 * H)).toBeNull();
  });
});
