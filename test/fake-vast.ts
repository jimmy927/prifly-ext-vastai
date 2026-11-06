/** A fake Vast.ai, a fake session and the tools wired to them, for the tool tests. */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDIT_DEFAULTS } from "../credit";
import { type EnforceDeps, Enforcer } from "../enforce";
import type {
  ExtensionApi,
  ExtensionPick,
  ExtensionPickAnswer,
  ExtensionTool,
  ExtensionToolContext,
} from "../prifly-api";
import { fileStore, type Store } from "../store";
import { makeTools } from "../tools";
import { destroyInstance, isListed, withKeys } from "../vast-api";

export const H = 3_600_000;
export const NOW = 1_800_000_000_000;
export const SESSION = "0123abcd-1111-2222-3333-444455556666";
export const LABEL = "jimmy/s-0123abcd/job1";

export type Offer = { ask_contract_id: number; dph_total: number } & Record<string, unknown>;
export const offer = (id: number, rate: number, more: Record<string, unknown> = {}): Offer => ({
  ask_contract_id: id,
  dph_total: rate,
  gpu_name: "RTX 4090",
  num_gpus: 1,
  gpu_ram: 24564,
  cpu_cores_effective: 16,
  cpu_ram: 64000,
  disk_space: 200,
  reliability: 0.99,
  geolocation: "Sweden, SE",
  inet_down: 900,
  rentable: true,
  ...more,
});

const CPU_PAGE = "https://www.cpubenchmark.net/high_end_cpus.html";

type Put = { url: string; body: Record<string, unknown> };

type Creates = Record<number, "ok" | "gone" | "error">;

/**
 * What `DELETE /api/v0/instances/<id>/` does on the fake: it answers each of
 * `answers` first (429, …), then 200, and a 200 takes the box off `instances`
 * unless `keep` is set. `deletes` is the id of every DELETE sent.
 */
function destroying(instances: Record<string, unknown>[]) {
  const destroy: { answers: number[]; keep: boolean; deletes: number[] } = {
    answers: [],
    keep: false,
    deletes: [],
  };
  const destroyBox = (id: number) => {
    destroy.deletes.push(id);
    const status = destroy.answers.shift() ?? 200;
    if (status !== 200) return Response.json({ msg: "API requests too frequent" }, { status });
    const at = destroy.keep ? -1 : instances.findIndex((box) => box["id"] === id);
    if (at >= 0) instances.splice(at, 1);
    return Response.json({ success: true });
  };
  return { destroy, destroyBox };
}

/** A fake Vast.ai: offers by id, the account's boxes, and what each create answers. */
export function vast(offers: Offer[], creates: Creates = {}) {
  const puts: Put[] = [];
  const instances: Record<string, unknown>[] = [];
  // The account: plenty of credit unless a test says otherwise; null answers 500.
  const account: { user: Record<string, unknown> | null } = {
    user: { credit: 10_000, balance_threshold: -0.01, balance_threshold_enabled: true },
  };
  // PassMark's page: null answers 403; `fetches` holds the User-Agent of each request.
  const cpuPage: { html: string | null; fetches: string[] } = { html: null, fetches: [] };
  const passmark = (init: RequestInit) => {
    cpuPage.fetches.push(String((init.headers as Record<string, string>)["User-Agent"]));
    return cpuPage.html === null
      ? new Response("blocked", { status: 403 })
      : new Response(cpuPage.html);
  };
  const search = (u: URL) => {
    const q = JSON.parse(u.searchParams.get("q") ?? "{}");
    const wanted = q.ask_contract_id?.eq;
    return Response.json({
      offers: offers.filter((o) => wanted === undefined || o.ask_contract_id === wanted),
    });
  };
  const create = (url: string, id: number, body: Record<string, unknown>) => {
    puts.push({ url, body });
    const how = creates[id] ?? "ok";
    if (how === "gone") return Response.json({ success: false, msg: "offer unavailable" });
    if (how === "error") return new Response("bad gateway", { status: 502 });
    instances.push({
      id: 9000 + id,
      label: body["label"],
      dph_total: 1,
      start_date: NOW / 1000,
      machine_id: offers.find((o) => o.ask_contract_id === id)?.["machine_id"],
      ssh_host: "ssh9.vast.ai",
      ssh_port: 10_000 + id,
    });
    return Response.json({ success: true, new_contract: 9000 + id });
  };
  const { destroy, destroyBox } = destroying(instances);
  const user = () =>
    account.user === null ? new Response("down", { status: 500 }) : Response.json(account.user);
  const get = async (url: string, init: RequestInit): Promise<Response> => {
    if (url === CPU_PAGE) return passmark(init);
    if (init.method === "DELETE") return destroyBox(Number(new URL(url).pathname.split("/")[4]));
    return await vastGet(url, init);
  };
  const vastGet = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const put = init.method === "PUT";
    if (u.pathname === "/api/v0/bundles/") return search(u);
    if (u.pathname === "/api/v1/instances/") return Response.json({ instances });
    if (u.pathname === "/api/v0/users/current/") return user();
    if (put && u.pathname.startsWith("/api/v0/asks/")) {
      return create(url, Number(u.pathname.split("/")[4]), JSON.parse(String(init.body)));
    }
    if (put && u.pathname.startsWith("/api/v0/instances/request_logs/")) {
      return Response.json({ result_url: "https://logs.example/l" });
    }
    if (url === "https://logs.example/l") return new Response("a\nb\nc\nd");
    return new Response("unexpected", { status: 500 });
  };
  return { get, puts, instances, account, cpuPage, destroy };
}

/** What a test may change about the tools' enforcer and the cancel's wait. */
export type SetupOptions = {
  /** Lease enforcement as config.json has it; on, the default, unless a test turns it off. */
  enforce?: boolean;
  cancelWaitMs?: number;
  enforceDeps?: Partial<EnforceDeps>;
};

/**
 * The tools on a fake Vast.ai, keeping their leases in `store` (the folder's
 * files when left out). Their take-down is a real `Enforcer` over the same
 * fake: DELETE goes to the fake, the box list is read from it, and nothing
 * waits for real; `notices` is what the enforcer told the reader.
 */
export async function setup(
  fake: ReturnType<typeof vast>,
  features: readonly string[] = [],
  storeOf: (folder: string) => Store = fileStore,
  options: SetupOptions = {},
) {
  const folder = await mkdtemp(join(tmpdir(), "vastai-tools-"));
  const store = storeOf(folder);
  const notices: string[] = [];
  const api = {
    folder,
    log: () => undefined,
    notify: (text: string) => notices.push(text),
    sessions: () => [{ id: SESSION, title: "", cwd: "/", state: "done" }],
  } as unknown as ExtensionApi;
  const sleep = async () => undefined;
  const enforce = options.enforce ?? true;
  const enforcer = new Enforcer(
    api,
    store,
    { sshKey: null, enforce, owner: "jimmy" },
    {
      destroy: (id) => withKeys(["key"], (key) => destroyInstance(key, id, fake.get, sleep)),
      isListed: (id) => isListed(["key"], id, fake.get),
      onBox: async () => ({ code: 0, out: "", err: "" }),
      sleep,
      ...options.enforceDeps,
    },
  );
  const tools = makeTools({
    store,
    owner: async () => "jimmy",
    sshKey: null,
    keys: async () => ["key"],
    get: fake.get,
    now: () => NOW,
    sleep,
    refresh: () => undefined,
    log: () => undefined,
    features,
    credit: CREDIT_DEFAULTS,
    enforce,
    takeDown: (box) => enforcer.cancelNow(box),
    ...(options.cancelWaitMs === undefined ? {} : { cancelWaitMs: options.cancelWaitMs }),
  });
  const tool = (name: string): ExtensionTool => {
    const found = tools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  return { folder, store, tool, notices, enforcer };
}

/** A fake session that answers each pick card from a script, and notes the world as it asked. */
export function ctxFor(answers: ExtensionPickAnswer[], onPick?: (card: ExtensionPick) => void) {
  const cards: ExtensionPick[] = [];
  const ctx: ExtensionToolContext = {
    session: SESSION,
    signal: new AbortController().signal,
    pick: async (card) => {
      cards.push(card);
      onPick?.(card);
      return answers.shift() ?? null;
    },
  };
  return { ctx, cards };
}
