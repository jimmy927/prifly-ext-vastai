import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDIT_DEFAULTS } from "../credit";
import { machineOf, machinesOf } from "../index";
import { readLeases } from "../leases";
import type { RentRequest } from "../prifly-api";
import { nameFor, rentHandler, suggestedBudget } from "../rent-dialog";
import { parseLabel } from "../rules";
import { fileStore } from "../store";
import type { ToolDeps } from "../tool-kit";
import type { Instance } from "../vast-api";
import { ctxFor, NOW, offer, SESSION, vast } from "./fake-vast";

const CONFIG = {
  refreshSeconds: 60,
  sshKey: null,
  enforce: false,
  owner: "jimmy",
  credit: CREDIT_DEFAULTS,
};
const box = (more: Record<string, unknown> = {}) =>
  ({
    id: 9001,
    label: "jimmy/s-0123abcd/job1",
    actual_status: "running",
    dph_total: 0.5,
    ssh_host: "ssh9.vast.ai",
    ssh_port: 10_001,
    ...more,
  }) as Instance;

describe("machines with rent-from-dialog", () => {
  test("a running box offers setup claude-code; the provider offers a rent row", () => {
    const machines = machinesOf([box()], CONFIG, new Map(), [], null, ["rent-from-dialog"]);
    expect(machines[0]?.setup).toBe("claude-code");
    const provider = machines.find((m) => m.kind === "provider");
    expect(provider?.rent).toEqual({ needs: ["cpu", "gpu"] });
  });

  test("a running box with an ODI-style label and no session offers setup and has no owner session", () => {
    const foreign = box({ label: "gpu-box-7ddfcb80" });
    const one = machineOf(foreign, CONFIG, undefined, true);
    expect(one.setup).toBe("claude-code");
    expect(one.ownerSession).toBe("");
    expect(one.trust).toBe("ask-first");
    const machines = machinesOf([foreign], CONFIG, new Map(), [], null, ["rent-from-dialog"]);
    const listed = machines.find((m) => m.key === "9001");
    expect(listed?.setup).toBe("claude-code");
    expect(listed?.ownerSession).toBe("");
  });

  test("a running box claimed by a session offers setup claude-code with that session as owner", () => {
    const claimed = machineOf(box(), CONFIG, undefined, true);
    expect(claimed.setup).toBe("claude-code");
    expect(claimed.ownerSession).not.toBe("");
    expect(claimed.trust).toBe("use-freely");
  });

  test("a box that is not running offers no setup", () => {
    const stopped = box({ actual_status: "exited" });
    expect(machineOf(stopped, CONFIG, undefined, true).setup).toBeUndefined();
  });

  test("without the feature neither field is sent", () => {
    const machines = machinesOf([box()], CONFIG, new Map(), [], null);
    for (const machine of machines) {
      expect("setup" in machine).toBe(false);
      expect("rent" in machine).toBe(false);
    }
    expect("setup" in machineOf(box(), CONFIG, undefined)).toBe(false);
  });
});

describe("the rent handler", () => {
  const REQ: RentRequest = {
    sessionId: SESSION,
    need: "cpu",
    hours: 2,
    purpose: "Embed the corpus",
  };
  async function world(offers = [offer(101, 0.5), offer(102, 0.4)], creates = {}) {
    const fake = vast(offers, creates);
    const folder = await mkdtemp(join(tmpdir(), "vastai-dialog-"));
    const store = fileStore(folder);
    const deps: ToolDeps = {
      store,
      owner: async () => "jimmy",
      sshKey: null,
      keys: async () => ["key"],
      get: fake.get,
      now: () => NOW,
      sleep: async () => undefined,
      refresh: () => undefined,
      log: () => undefined,
      features: ["rent-from-dialog"],
      credit: CREDIT_DEFAULTS,
    };
    return { fake, store, handler: rentHandler(deps) };
  }

  test("a confirmed card creates a box labelled for the session and returns its key", async () => {
    const { fake, store, handler } = await world();
    const { ctx, cards } = ctxFor([{ row: 0, amount: 3 }]);
    const result = await handler(REQ, ctx);
    // 102 is cheapest per hour; it is first on the card and rented.
    expect(result).toEqual({ ok: true, key: "9102" });
    const card = cards[0];
    expect(card?.action).toBe("Rent");
    expect(card?.title).toContain("Embed the corpus");
    // 0.40 $/h (disk included, the fake prices it as given) for 2 h, plus 25 %.
    expect(card?.amount?.value).toBe(1);
    const put = fake.puts[0];
    expect(put?.body["image"]).toBe("ubuntu:22.04");
    expect(String(put?.body["onstart"])).toContain("sleep infinity");
    const label = String(put?.body["label"]);
    expect(label).toBe("jimmy/s-0123abcd/embedthe");
    expect(parseLabel(label)?.session).toBe(SESSION.slice(0, 8));
    const leases = await readLeases(store);
    expect(leases.map((l) => l.budget)).toEqual([3]);
  });

  test("a cancelled card is Not rented and creates nothing", async () => {
    const { fake, store, handler } = await world();
    const result = await handler(REQ, ctxFor([null]).ctx);
    expect(result).toEqual({ ok: false, reason: "Not rented" });
    expect(fake.puts).toHaveLength(0);
    expect(await readLeases(store)).toHaveLength(0);
  });

  test("an error comes back as the reason", async () => {
    const none = await world([]);
    const empty = await none.handler(REQ, ctxFor([]).ctx);
    expect(empty.ok).toBe(false);
    expect(empty.ok ? "" : empty.reason).toContain("No cpu offer");
    const failing = await world([offer(101, 0.5)], { 101: "error" });
    const failed = await failing.handler(REQ, ctxFor([{ row: 0, amount: 3 }]).ctx);
    expect(failed.ok).toBe(false);
    expect(failed.ok ? "" : failed.reason).toContain("No box was rented");
    const bad = await failing.handler({ ...REQ, hours: 0 }, ctxFor([]).ctx);
    expect(bad).toEqual({ ok: false, reason: "The hours are not a number above 0." });
  });

  test("a gpu need searches with a VRAM floor", async () => {
    const small = offer(103, 0.1, { gpu_ram: 8000 });
    const { handler } = await world([small, offer(104, 0.6)]);
    const { ctx, cards } = ctxFor([null]);
    await handler({ ...REQ, need: "gpu" }, ctx);
    expect(cards[0]?.rows.map((r) => r.at(-1))).toEqual(["104"]);
  });
});

describe("names and budgets", () => {
  test("a name is derived from the purpose and kept unique", () => {
    expect(nameFor("Embed the corpus!", new Set())).toBe("embedthe");
    expect(nameFor("Embed the corpus!", new Set(["embedthe"]))).toBe("embedth2");
    expect(nameFor("???", new Set())).toBe("box");
  });

  test("the budget is the best rate for the hours plus 25 %, rounded up to the cent", () => {
    expect(suggestedBudget(0.5, 2)).toBe(1.25);
    expect(suggestedBudget(0.333, 1)).toBe(0.42);
  });
});
