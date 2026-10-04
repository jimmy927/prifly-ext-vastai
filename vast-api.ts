/**
 * Vast.ai's REST API: the list of rented boxes, and what the tools and the
 * enforcer do to them — create, request logs, destroy. No CLI, no Python.
 *
 * The list used to be `vastai show instances --raw` once a minute. Each run
 * started Python and imported the CLI (requests, rich, …): measured on
 * 2026-09-28 on WSL2, 30–40 MB read off disk per run — WSL drops the page
 * cache every ~30 s, so it never stayed warm — about 31 MB/min of the prifly
 * host's disk reads, plus a Python start-up's CPU. One HTTPS GET from the
 * host's own Bun reads nothing off disk but the key file.
 *
 * It asks what the CLI (vastai 1.6.0, `api/instances.py` `show_instances`)
 * asks, in the same way: `GET /api/v1/instances/` with a Bearer key, 25 rows
 * a page, following `next_token`. Creating, request-logs and destroy send what
 * the CLI's `api/instances.py` sends (`PUT /api/v0/asks/<id>/`,
 * `PUT /api/v0/instances/request_logs/<id>/`, `DELETE /api/v0/instances/<id>/`).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "./credit";
import type { ExtensionVaultApi } from "./prifly-api";

/** The CLI's own default, and its `VAST_URL` override. */
export const SERVER = process.env["VAST_URL"] ?? "https://console.vast.ai";
const PAGE_ROWS = 25;
/** The old CLI call was killed after 30 s; a page is ~1 s. */
const TIMEOUT_MS = 30_000;
/** A runaway `next_token` must not loop for ever: 40 pages is 1,000 boxes. */
const MAX_PAGES = 40;

/**
 * A field Vast.ai sends, or `undefined` when it is missing, null where it
 * should not be, or of another type — one odd field never drops a box.
 */
export function field<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

/** The CLI strips whitespace from every string it prints; labels come with it. */
export const text = z.string().trim();

/** One box: only what this extension shows and judges. Unknown fields are dropped. */
export const InstanceSchema = z.object({
  id: field(z.number()),
  label: field(text.nullable()),
  gpu_name: field(text),
  num_gpus: field(z.number()),
  actual_status: field(text.nullable()),
  intended_status: field(text.nullable()),
  dph_total: field(z.number()),
  /** Dollars an hour for the disk alone: what a stopped box bills. */
  storage_total_cost: field(z.number()),
  cpu_util: field(z.number().nullable()),
  gpu_util: field(z.number().nullable()),
  mem_usage: field(z.number().nullable()),
  mem_limit: field(z.number().nullable()),
  ssh_host: field(text),
  ssh_port: field(z.number()),
  /** Epoch seconds. */
  start_date: field(z.number()),
  /**
   * Epoch seconds: the host's end date, fixed from its offer when the box was
   * rented. Vast.ai stops the box then. Null or missing when there is none.
   */
  end_date: field(z.number().nullable()),
  /** Running totals of billed traffic, in KiB: a box downloading is not idle. */
  inet_up_billed: field(z.number().nullable()),
  inet_down_billed: field(z.number().nullable()),
});

export type Instance = z.infer<typeof InstanceSchema>;

const PageSchema = z.object({
  instances: z.array(z.unknown()).nullish(),
  next_token: z.string().nullish(),
});

/** The rows of one page that are boxes at all; the next page's token, or null. */
export function parsePage(body: unknown): { rows: Instance[]; next: string | null } {
  const page = PageSchema.safeParse(body);
  if (!page.success) throw new Error("Vast.ai sent an instance list this extension cannot read");
  const rows = (page.data.instances ?? []).flatMap((row) => {
    const parsed = InstanceSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return { rows, next: page.data.next_token || null };
}

/**
 * The prifly vault entry the key is read from first: an `api-token` entry at
 * level 1, named under `vault` in `prifly-extension.json` so prifly hands it over.
 */
export const VAULT_ENTRY = "vastai";

/**
 * The keys to try: the token of prifly's vault entry `vastai`, when there is
 * one and prifly has `api.vault`; then the CLI's own, in its order
 * (`cli/main.py`): `$VAST_API_KEY`; else the 2FA session key, then the API
 * key, in `$XDG_CONFIG_HOME/vastai/`; else the legacy `~/.vast_api_key`. The
 * CLI falls back from an expired 2FA key to the API key, so both are tried,
 * and a refused vault key falls back to the CLI's the same way. Read fresh
 * each refresh: a vault entry changed or fenced, `vastai set api-key` or a
 * new 2FA login is picked up without restarting.
 */
export async function readApiKeys(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  vault?: ExtensionVaultApi,
): Promise<string[]> {
  const fromVault = (await vault?.read(VAULT_ENTRY))?.trim();
  const keys: string[] = fromVault ? [fromVault] : [];
  const fromEnv = env["VAST_API_KEY"]?.trim();
  if (fromEnv) return keys.includes(fromEnv) ? keys : [...keys, fromEnv];
  const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "vastai");
  const files = [
    join(config, "vast_tfa_key"),
    join(config, "vast_api_key"),
    join(home, ".vast_api_key"),
  ];
  for (const path of files) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const key = (await file.text()).trim();
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A refused key: Vast.ai said 401 or 403, so the next key may still work. */
export class KeyRefused extends Error {}

/** Run `attempt` with each key in turn; only a refused key moves on to the next. */
export async function withKeys<T>(
  keys: readonly string[],
  attempt: (key: string) => Promise<T>,
): Promise<T> {
  if (keys.length === 0) {
    throw new Error(
      "No Vast.ai API key: add an api-token entry `vastai` (level 1) to prifly's vault, or run `vastai set api-key <KEY>`",
    );
  }
  let refused: Error | null = null;
  for (const key of keys) {
    try {
      return await attempt(key);
    } catch (caught) {
      if (!(caught instanceof KeyRefused)) throw caught;
      refused = caught;
    }
  }
  throw refused ?? new Error("Vast.ai refused every API key");
}

/** Every box on the account, as the CLI's `show instances --raw` lists them. */
export function listInstances(keys: readonly string[], get: Fetch = fetch): Promise<Instance[]> {
  return withKeys(keys, (key) => allPages(key, get));
}

async function allPages(key: string, get: Fetch): Promise<Instance[]> {
  const rows: Instance[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const parsed = parsePage(await fetchPage(key, after, get));
    rows.push(...parsed.rows);
    if (parsed.next === null) return rows;
    after = parsed.next;
  }
  throw new Error(`Vast.ai kept paging past ${MAX_PAGES * PAGE_ROWS} boxes`);
}

async function fetchPage(key: string, after: string | null, get: Fetch): Promise<unknown> {
  const query = new URLSearchParams({
    select_filters: "{}",
    order_by: JSON.stringify([{ col: "id", dir: "asc" }]),
    limit: String(PAGE_ROWS),
    ...(after === null ? {} : { after_token: after }),
  });
  const response = await get(`${SERVER}/api/v1/instances/?${query}`, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "prifly-ext-vastai" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return await response.json();
  throw await failure("instance list", response);
}

/** The error for a refused request: what Vast.ai said in `msg`, never the key. */
async function failure(what: string, response: Response): Promise<Error> {
  const why = z.object({ msg: z.string() }).safeParse(await response.json().catch(() => null));
  const message = `Vast.ai ${what} failed (${response.status})${why.success ? `: ${why.data.msg.slice(0, 200)}` : ""}`;
  return response.status === 401 || response.status === 403
    ? new KeyRefused(message)
    : new Error(message);
}

const AccountSchema = z.object({
  credit: z.number(),
  balance_threshold: field(z.number().nullable()),
  balance_threshold_enabled: field(z.boolean().nullable()),
});

/**
 * The account's credit, and the balance at which Vast.ai stops every box on
 * it (null when that auto-stop is off): `GET /api/v0/users/current/`, as the
 * CLI's `show user` asks. Vast.ai has no call that adds credit; the reader
 * tops up in the console, and the next read shows it.
 */
export async function getAccount(key: string, get: Fetch = fetch): Promise<Account> {
  const response = await get(`${SERVER}/api/v0/users/current/`, authorized(key, "GET"));
  if (!response.ok) throw await failure("account read", response);
  const parsed = AccountSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Vast.ai sent an account this extension cannot read");
  const { credit, balance_threshold: threshold, balance_threshold_enabled: on } = parsed.data;
  return { credit, threshold: on === false ? null : (threshold ?? null) };
}

function authorized(key: string, method: string, json?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": "prifly-ext-vastai",
      ...(json === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/** Destroy a box: it stops billing and its disk is deleted. The call `guard.sh` makes. */
export async function destroyInstance(key: string, id: number, get: Fetch = fetch): Promise<void> {
  const response = await get(`${SERVER}/api/v0/instances/${id}/`, authorized(key, "DELETE"));
  if (!response.ok) throw await failure(`destroy of #${id}`, response);
}

/** What the CLI's `create instance --ssh --direct --cancel-unavail` sends for one offer. */
export type CreateRequest = {
  image: string;
  /** GB. */
  disk: number;
  label: string;
  onstart: string;
  /** `KEY: value`, and `-p 8080:8080/tcp: "1"` for a port. */
  env: Record<string, string>;
};

const CreateAnswer = z.object({
  success: z.boolean(),
  new_contract: z.number().optional(),
  msg: z.string().optional(),
  error: z.string().optional(),
});

/** Vast.ai said no to a create: the offer is gone or no longer fits, and with `cancel_unavail` nothing was created. */
export class OfferGone extends Error {}

/**
 * Rent an offer: the new instance's id. Throws `OfferGone` when Vast.ai says
 * no. Any other error — offline, a 5xx, an answer this cannot read — leaves
 * it unknown whether a box was created, so the caller looks for one.
 */
export async function createInstance(
  key: string,
  offer: number,
  request: CreateRequest,
  get: Fetch = fetch,
): Promise<number> {
  const body = {
    client_id: "me",
    image: request.image,
    env: request.env,
    price: null,
    disk: request.disk,
    label: request.label,
    extra: null,
    onstart: request.onstart,
    image_login: null,
    python_utf8: false,
    lang_utf8: false,
    use_jupyter_lab: false,
    jupyter_dir: null,
    force: false,
    cancel_unavail: true,
    template_hash_id: null,
    user: null,
    runtype: "ssh_direc ssh_proxy",
  };
  const response = await get(`${SERVER}/api/v0/asks/${offer}/`, authorized(key, "PUT", body));
  const what = `create of offer ${offer}`;
  if (response.status >= 500) throw await failure(what, response);
  if (!response.ok) {
    const refused = await failure(what, response);
    if (refused instanceof KeyRefused) throw refused;
    throw new OfferGone(refused.message);
  }
  const answer = CreateAnswer.safeParse(await response.json().catch(() => null));
  if (!answer.success)
    throw new Error(`Vast.ai answered the ${what} in a way this extension cannot read`);
  if (!answer.data.success || answer.data.new_contract === undefined) {
    const why = answer.data.msg ?? answer.data.error ?? "no reason given";
    throw new OfferGone(`Vast.ai did not create offer ${offer}: ${why.slice(0, 200)}`);
  }
  return answer.data.new_contract;
}

const LOG_POLLS = 30;
const LOG_POLL_MS = 300;

/**
 * A box's container logs, as the CLI's `logs` command: ask for them, then
 * fetch the URL Vast.ai fills in (the host uploads them; it can take seconds).
 */
export async function requestLogs(
  key: string,
  id: number,
  tail: number,
  get: Fetch = fetch,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<string> {
  const response = await get(
    `${SERVER}/api/v0/instances/request_logs/${id}/`,
    authorized(key, "PUT", { tail: String(tail) }),
  );
  if (!response.ok) throw await failure(`log request for #${id}`, response);
  const answer = z.object({ result_url: z.string() }).safeParse(await response.json());
  if (!answer.success) throw new Error(`Vast.ai gave no log address for #${id}`);
  for (let poll = 0; poll < LOG_POLLS; poll += 1) {
    await sleep(LOG_POLL_MS);
    // The result URL is a pre-signed address: no key goes to it.
    const logs = await get(answer.data.result_url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (logs.status === 200) return await logs.text();
  }
  throw new Error(
    `The logs of #${id} were not ready after ${(LOG_POLLS * LOG_POLL_MS) / 1000} s: the host may not be answering`,
  );
}
