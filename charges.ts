/**
 * What every box cost, day by day: Vast.ai's charges, for the spend panel.
 *
 * `GET /api/v0/charges/` lists one row per box for the days asked — but over
 * a range of days it sums each box's row across them ("Charges - 2 days"), so
 * it is asked one UTC day at a time, which gives what each box cost on that
 * day (checked 2026-10-06: a box's two single days added up to its two-day
 * row). Each row carries the box's label, so destroyed boxes count too, and
 * bandwidth is in the amount, which the hourly rate leaves out.
 *
 * A day that is over does not change, so each is kept in `charges.json` in
 * the extension's folder and asked again only while it may still be
 * settling: until a day after it ended, at most every ten minutes.
 */

import { join } from "node:path";
import { z } from "zod";
import { authorized, type Fetch, failure, field, SERVER, text } from "./vast-api";

const DAY_MS = 86_400_000;
/** A day's charges may still move until this long after it ended. */
const SETTLE_MS = DAY_MS;
/** How often a day still settling is asked again. */
const STALE_MS = 10 * 60_000;
const PAGE_ROWS = 500;
const MAX_PAGES = 20;
/** Days asked at once. */
const PARALLEL = 3;
/** How often a 429 is waited out (1, 2, 4, 8 s) before the day counts as failed. */
const RETRIES_429 = 4;

export type ChargeRow = {
  /** The Vast.ai instance id; null for a row of another kind (a volume, serverless). */
  box: number | null;
  /** Its label as Vast.ai had it, or "". */
  label: string;
  /** "instance", "volume" or "serverless". */
  kind: string;
  /** Dollars. */
  amount: number;
};

const RowSchema = z.object({
  type: field(text),
  source: field(text.nullable()),
  amount: z.number(),
  metadata: field(z.object({ label: field(text.nullable()) }).nullable()),
});

const PageSchema = z.object({
  results: z.array(z.unknown()),
  next_token: field(z.string().nullable()),
});

/** One page of charges: the rows it could read, and the next page's token. */
export function parseChargePage(body: unknown): { rows: ChargeRow[]; next: string | null } {
  const page = PageSchema.parse(body);
  const rows: ChargeRow[] = [];
  for (const raw of page.results) {
    const parsed = RowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { type, source, amount, metadata } = parsed.data;
    const id = /^instance-(\d+)$/.exec(source ?? "")?.[1];
    rows.push({
      box: id === undefined ? null : Number(id),
      label: metadata?.label ?? "",
      kind: type ?? "instance",
      amount,
    });
  }
  return { rows, next: page.next_token || null };
}

/** `2026-10-05`: the UTC day of an epoch ms. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch ms of a UTC day's start. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** The last `count` UTC days, oldest first, the newest today. */
export function lastDays(count: number, now: number): string[] {
  const today = dayStart(dayOf(now));
  return Array.from({ length: count }, (_, i) => dayOf(today - (count - 1 - i) * DAY_MS));
}

/**
 * One request, asked again after a pause while Vast.ai answers 429 ("API
 * requests too frequent"): asking 90 days four at a time met it on 3 of them
 * (2026-10-06).
 */
async function getPatiently(
  url: string,
  init: () => RequestInit,
  get: Fetch,
  sleep: (ms: number) => Promise<unknown>,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await get(url, init());
    if (response.status !== 429 || attempt >= RETRIES_429) return response;
    await sleep(1000 * 2 ** attempt);
  }
}

/** What every box cost on one UTC day. */
export async function fetchDay(
  key: string,
  day: string,
  get: Fetch = fetch,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<ChargeRow[]> {
  const from = dayStart(day) / 1000;
  const filters = JSON.stringify({ day: { gte: from, lte: from + 86_399 } });
  const rows: ChargeRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      select_filters: filters,
      limit: String(PAGE_ROWS),
      ...(after === null ? {} : { after_token: after }),
    });
    // The trailing slash matters: without it Vast.ai answers 301.
    const response = await getPatiently(
      `${SERVER}/api/v0/charges/?${query}`,
      () => authorized(key, "GET"),
      get,
      sleep,
    );
    if (!response.ok) throw await failure(`charges of ${day}`, response);
    const parsed = parseChargePage(await response.json());
    rows.push(...parsed.rows);
    if (parsed.next === null) return rows;
    after = parsed.next;
  }
  throw new Error(`Vast.ai kept paging past ${MAX_PAGES * PAGE_ROWS} charges on ${day}`);
}

const CachedSchema = z.object({
  days: z.record(
    z.string(),
    z.object({
      at: z.number(),
      rows: z.array(
        z.object({
          box: z.number().nullable(),
          label: z.string(),
          kind: z.string(),
          amount: z.number(),
        }),
      ),
    }),
  ),
});
type Cached = z.infer<typeof CachedSchema>;

/** Whether a day kept at `at` is asked again at `now`. */
export function isStale(day: string, at: number, now: number): boolean {
  return at < dayStart(day) + DAY_MS + SETTLE_MS && now - at > STALE_MS;
}

export function chargesPath(folder: string): string {
  return join(folder, "charges.json");
}

/** The days' charges, from `charges.json`, asking Vast.ai for the days missing or still settling. */
export class ChargeCache {
  readonly #path: string;
  readonly #fetch: (day: string) => Promise<ChargeRow[]>;
  #cached: Cached | null = null;
  /** Days being asked now, so two panels opening at once ask once. */
  readonly #asking = new Map<string, Promise<void>>();

  constructor(path: string, fetchDay: (day: string) => Promise<ChargeRow[]>) {
    this.#path = path;
    this.#fetch = fetchDay;
  }

  /** Each day's rows; a day Vast.ai could not be asked for is left out and named in `failed`. */
  async days(
    days: readonly string[],
    now: number,
  ): Promise<{ rows: Map<string, ChargeRow[]>; failed: string[] }> {
    const cached = await this.#load();
    const due = days.filter((day) => {
      const kept = cached.days[day];
      return kept === undefined || isStale(day, kept.at, now);
    });
    const failed: string[] = [];
    for (let i = 0; i < due.length; i += PARALLEL) {
      await Promise.all(
        due.slice(i, i + PARALLEL).map((day) =>
          this.#ask(cached, day, now).catch(() => {
            if (cached.days[day] === undefined) failed.push(day);
          }),
        ),
      );
    }
    if (due.length > 0) await Bun.write(this.#path, `${JSON.stringify(cached)}\n`);
    const rows = new Map<string, ChargeRow[]>();
    for (const day of days) {
      const kept = cached.days[day];
      if (kept !== undefined) rows.set(day, kept.rows);
    }
    return { rows, failed };
  }

  #ask(cached: Cached, day: string, now: number): Promise<void> {
    const running = this.#asking.get(day);
    if (running !== undefined) return running;
    const asking = this.#fetch(day)
      .then((rows) => {
        cached.days[day] = { at: now, rows };
      })
      .finally(() => this.#asking.delete(day));
    this.#asking.set(day, asking);
    return asking;
  }

  async #load(): Promise<Cached> {
    if (this.#cached !== null) return this.#cached;
    const raw: unknown = await Bun.file(this.#path)
      .json()
      .catch(() => null);
    const parsed = CachedSchema.safeParse(raw);
    this.#cached = parsed.success ? parsed.data : { days: {} };
    return this.#cached;
  }
}
