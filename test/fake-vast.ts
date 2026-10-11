/** A fake Vast.ai, a fake session and the tools wired to them, for the tool tests. */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDIT_DEFAULTS } from "../credit";
import type {
  ExtensionPick,
  ExtensionPickAnswer,
  ExtensionTool,
  ExtensionToolContext,
} from "../prifly-api";
import { fileStore, type Store } from "../store";
import { makeTools } from "../tools";

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
  const user = () =>
    account.user === null ? new Response("down", { status: 500 }) : Response.json(account.user);
  const get = async (url: string, init: RequestInit): Promise<Response> =>
    url === CPU_PAGE ? passmark(init) : await vastGet(url, init);
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
  return { get, puts, instances, account, cpuPage };
}

/** The tools on a fake Vast.ai, keeping their leases in `store` (the folder's files when left out). */
export async function setup(
  fake: ReturnType<typeof vast>,
  features: readonly string[] = [],
  storeOf: (folder: string) => Store = fileStore,
) {
  const folder = await mkdtemp(join(tmpdir(), "vastai-tools-"));
  const store = storeOf(folder);
  const tools = makeTools({
    store,
    owner: async () => "jimmy",
    sshKey: null,
    keys: async () => ["key"],
    get: fake.get,
    now: () => NOW,
    sleep: async () => undefined,
    refresh: () => undefined,
    log: () => undefined,
    features,
    credit: CREDIT_DEFAULTS,
  });
  const tool = (name: string): ExtensionTool => {
    const found = tools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  return { folder, store, tool };
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
