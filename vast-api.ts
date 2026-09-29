/**
 * The list of rented boxes, straight from Vast.ai's REST API.
 *
 * This used to be `vastai show instances --raw` once a minute. Each run
 * started Python and imported the CLI (requests, rich, …): measured on
 * 2026-09-28 on WSL2, 30–40 MB read off disk per run — WSL drops the page
 * cache every ~30 s, so it never stayed warm — about 31 MB/min of the prifly
 * host's disk reads, plus a Python start-up's CPU. One HTTPS GET from the
 * host's own Bun reads nothing off disk but the key file.
 *
 * It asks what the CLI (vastai 1.6.0, `api/instances.py` `show_instances`)
 * asks, in the same way: `GET /api/v1/instances/` with a Bearer key, 25 rows
 * a page, following `next_token`. Everything else — renting, destroying,
 * labelling — still goes through the CLI.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** The CLI's own default, and its `VAST_URL` override. */
const SERVER = process.env["VAST_URL"] ?? "https://console.vast.ai";
const PAGE_ROWS = 25;
/** The old CLI call was killed after 30 s; a page is ~1 s. */
const TIMEOUT_MS = 30_000;
/** A runaway `next_token` must not loop for ever: 40 pages is 1,000 boxes. */
const MAX_PAGES = 40;

/**
 * A field Vast.ai sends, or `undefined` when it is missing, null where it
 * should not be, or of another type — one odd field never drops a box.
 */
function field<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

/** The CLI strips whitespace from every string it prints; labels come with it. */
const text = z.string().trim();

/** One box: only what this extension shows and judges. Unknown fields are dropped. */
export const InstanceSchema = z.object({
  id: field(z.number()),
  label: field(text.nullable()),
  gpu_name: field(text),
  num_gpus: field(z.number()),
  actual_status: field(text.nullable()),
  intended_status: field(text.nullable()),
  dph_total: field(z.number()),
  cpu_util: field(z.number().nullable()),
  gpu_util: field(z.number().nullable()),
  mem_usage: field(z.number().nullable()),
  mem_limit: field(z.number().nullable()),
  ssh_host: field(text),
  ssh_port: field(z.number()),
  /** Epoch seconds. */
  start_date: field(z.number()),
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
 * The keys to try, in the CLI's order (`cli/main.py`): `$VAST_API_KEY`; else
 * the 2FA session key, then the API key, in `$XDG_CONFIG_HOME/vastai/`; else
 * the legacy `~/.vast_api_key`. The CLI falls back from an expired 2FA key to
 * the API key, so both are tried. Read fresh each refresh: `vastai set
 * api-key` or a new 2FA login is picked up without restarting.
 */
export async function readApiKeys(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): Promise<string[]> {
  const fromEnv = env["VAST_API_KEY"]?.trim();
  if (fromEnv) return [fromEnv];
  const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "vastai");
  const files = [
    join(config, "vast_tfa_key"),
    join(config, "vast_api_key"),
    join(home, ".vast_api_key"),
  ];
  const keys: string[] = [];
  for (const path of files) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const key = (await file.text()).trim();
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Every box on the account, as the CLI's `show instances --raw` lists them. */
export async function listInstances(
  keys: readonly string[],
  get: Fetch = fetch,
): Promise<Instance[]> {
  if (keys.length === 0) {
    throw new Error("No Vast.ai API key: run `vastai set api-key <KEY>`");
  }
  let refused: Error | null = null;
  for (const key of keys) {
    try {
      return await allPages(key, get);
    } catch (caught) {
      // Only a refused key moves on to the next one; anything else is said.
      if (!(caught instanceof KeyRefused)) throw caught;
      refused = caught;
    }
  }
  throw refused ?? new Error("Vast.ai refused every API key");
}

class KeyRefused extends Error {}

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
  // Vast.ai says why in `msg`; the key itself is never part of the message.
  const why = z.object({ msg: z.string() }).safeParse(await response.json().catch(() => null));
  const message = `Vast.ai instance list failed (${response.status})${why.success ? `: ${why.data.msg.slice(0, 200)}` : ""}`;
  if (response.status === 401 || response.status === 403) throw new KeyRefused(message);
  throw new Error(message);
}
