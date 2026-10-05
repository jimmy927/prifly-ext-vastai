/**
 * Boxes that turn out broken, and what happens to them. `enforce.ts` calls
 * `watch` for every leased box each round.
 *
 * A box counts as broken when
 * - it is running but ssh has not let us in, refusing or timing out, for
 *   3 minutes continuously, counted from the first failed probe;
 * - its log shows "bad ownership or modes" (sshd refusing authorized_keys); or
 * - it stays in created or loading for more than 10 minutes.
 *
 * A broken box that holds a replacement plan (`lease.replace`, kept by
 * `vast_rent`) is cancelled as `vast_cancel` does, so `/root/.lease/save`
 * runs, its machine is left out, and the next offer of the card the reader
 * already confirmed is rented under the same label with what is left of the
 * confirmed budget (`replace.ts`): no new card, and the session need not have
 * noticed. At most `MAX_REPLACEMENTS` times for one rent. A box that let ssh
 * in once is never broken for ssh: a session that drops later is not a box
 * that never worked.
 */

import { homedir } from "node:os";
import { cancel, type Lease, type LeaseTarget, type Replace, updateLeases } from "./leases";
import type { DecorationTone, ExtensionApi } from "./prifly-api";
import { MAX_REPLACEMENTS, type ReplaceDeps, rentNext } from "./replace";
import { parseLabel, span, type Verdict } from "./rules";
import type { onBox } from "./run";
import { sshTarget } from "./run";
import { budgetText, dollars, spentOf } from "./spend";
import { type Fetch, type Instance, readApiKeys } from "./vast-api";

/** A running box ssh has not let into for this long, never once, is broken. */
const SSH_DOWN_MS = 3 * 60_000;
/** A box in created or loading for longer than this is broken. */
const STUCK_MS = 10 * 60_000;
/** Only a box this young is watched for ssh. */
const WATCH_MS = 3_600_000;
const PROBE_MS = 25_000;
/** Lines of log read to look for the refusal. */
export const LOG_TAIL = 400;
/** What sshd logs when it refuses authorized_keys for its modes. */
const BAD_MODES = /bad ownership or modes/i;

/** What the watch reaches outside itself, replaceable so a test rents and probes nothing real. */
export type BrokenDeps = {
  /** Whether ssh to a box gets in: a login with a trivial command. The real one runs `true` over `onBox`. */
  probe?: (target: { host: string; port: number }, sshKey: string | null) => Promise<boolean>;
  /** The end of a box's container log; the real one asks Vast.ai. Without it no log is read. */
  logs?: (id: number) => Promise<string>;
  /** The API keys and the HTTP call a replacement is rented with; the real ones when left out. */
  keys?: () => Promise<string[]>;
  get?: Fetch;
};

export type BrokenHost = {
  api: ExtensionApi;
  /** With enforcement off nothing is probed, cancelled or rented. */
  enforce: boolean;
  sshKey: string | null;
  deps: BrokenDeps;
  onBox: typeof onBox;
  /** Tell the reader once for each key. */
  tell: (key: string, text: string, tone: DecorationTone, session: string | undefined) => void;
  /** The leases file. */
  file: string;
};

export class BrokenWatch {
  readonly #host: BrokenHost;
  /** Boxes ssh let us into once. */
  readonly #reached = new Set<number>();
  /** When ssh to each box first failed in its current run of failures. */
  readonly #sshDownSince = new Map<number, number>();
  /** When each box was first seen in created or loading. */
  readonly #stuckSince = new Map<number, number>();
  /** Boxes being probed or replaced now: those take a while, so they run beside the round. */
  readonly #busy = new Set<number>();
  /** The probes and replacements running, for `settled`. */
  readonly #running = new Set<Promise<void>>();

  constructor(host: BrokenHost) {
    this.#host = host;
  }

  /** Wait for the probes and replacements the last rounds started. */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }

  /** Forget boxes that are gone. */
  keep(live: ReadonlySet<number>): void {
    for (const seen of [this.#reached, this.#sshDownSince, this.#stuckSince]) {
      for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    }
  }

  /**
   * Look at one box of this prifly: broken boxes with a plan are replaced. What
   * takes time runs beside the round.
   */
  watch(box: Instance, lease: Lease | null, verdict: Verdict, now: number): void {
    const id = box.id;
    if (id === undefined || !this.#host.enforce || lease?.replace == null || lease.cancelled)
      return;
    if (verdict.kind !== "leased" && verdict.kind !== "ending" && verdict.kind !== "grace") return;
    const status = box.actual_status ?? box.intended_status;
    if (status === "created" || status === "loading") {
      this.#watchStart(box, id, lease, status, now);
      return;
    }
    this.#stuckSince.delete(id);
    if (status !== "running") this.#sshDownSince.delete(id);
    const target = sshTarget(box);
    const young = box.start_date === undefined || now - box.start_date * 1000 < WATCH_MS;
    if (target === null || this.#reached.has(id) || !young) return;
    this.#spawn(id, () => this.#probe(box, lease, target, now));
  }

  /** A box still starting: broken when it has been created or loading for more than 10 minutes. */
  #watchStart(box: Instance, id: number, lease: Lease, status: string, now: number): void {
    const since = this.#stuckSince.get(id) ?? now;
    this.#stuckSince.set(id, since);
    if (now - since <= STUCK_MS) return;
    this.#spawn(id, () =>
      this.#replace(box, lease, `stayed ${status} for ${span(now - since)}`, now),
    );
  }

  /** Run `job` beside the round, one at a time for each box. */
  #spawn(id: number, job: () => Promise<void>): void {
    if (this.#busy.has(id)) return;
    this.#busy.add(id);
    const running: Promise<void> = job()
      .catch((caught) =>
        this.#host.api.log("replace_failed", {
          instance: id,
          message: caught instanceof Error ? caught.message : String(caught),
        }),
      )
      .finally(() => {
        this.#busy.delete(id);
        this.#running.delete(running);
      });
    this.#running.add(running);
  }

  /** Try ssh into the box; replace it when it has not let us in for 3 minutes or its log says why it never will. */
  async #probe(
    box: Instance,
    lease: Lease,
    target: { host: string; port: number },
    now: number,
  ): Promise<void> {
    const { deps, onBox, sshKey } = this.#host;
    const id = box.id ?? 0;
    const probe =
      deps.probe ?? (async (to, key) => (await onBox(to, key, "true", PROBE_MS)).code === 0);
    if (await probe(target, sshKey)) {
      this.#reached.add(id);
      this.#sshDownSince.delete(id);
      return;
    }
    const since = this.#sshDownSince.get(id) ?? now;
    this.#sshDownSince.set(id, since);
    const log = await deps.logs?.(id).catch(() => "");
    if (log !== undefined && BAD_MODES.test(log)) {
      await this.#replace(
        box,
        lease,
        "its log shows bad ownership or modes for authorized_keys",
        now,
      );
    } else if (now - since >= SSH_DOWN_MS) {
      await this.#replace(box, lease, `ssh refused or timed out for ${span(now - since)}`, now);
    }
  }

  /**
   * A box is broken: cancel it as `vast_cancel` does (so it is saved and
   * destroyed), leave its machine out, and rent the next offer of the same
   * card under the same label with what is left of the confirmed budget.
   */
  async #replace(box: Instance, lease: Lease, reason: string, now: number): Promise<void> {
    const { api, deps, file, sshKey } = this.#host;
    const state = lease.replace ?? null;
    const id = box.id;
    const label = box.label ?? "";
    if (state === null || id === undefined) return;
    const parsed = parseLabel(label);
    const say = (text: string) =>
      this.#host.tell(`${id}:replaced`, text, "warning", parsed?.session);
    const target: LeaseTarget = lease.box === null ? { label } : { box: id };
    await updateLeases(file, (leases) => cancel(leases, target));
    api.log("broken", { instance: id, reason, count: state.count });
    const next = advance(state, box, reason, now);
    const gone = `${parsed?.name ?? `#${id}`} (#${id}) is broken (${reason}) and is saved and destroyed`;
    if (state.count >= MAX_REPLACEMENTS) {
      say(
        `${gone}. This rent has already replaced ${MAX_REPLACEMENTS} broken boxes, so no more are rented: vast_offers and vast_rent start a new one.`,
      );
      return;
    }
    const rentDeps: ReplaceDeps = {
      folder: api.folder,
      keys: deps.keys ?? (() => readApiKeys(process.env, homedir(), api.vault)),
      get: deps.get ?? fetch,
      now: () => now,
      log: (event, fields) => api.log(event, fields),
      sshKey,
    };
    const rented = await rentNext(rentDeps, label, next);
    if (rented.kind === "none") {
      say(`${gone}. No replacement was rented: ${rented.why}.`);
      return;
    }
    const ssh = rented.ssh ?? "no address yet, vast_boxes shows it";
    say(
      `${gone}. Replaced by #${rented.box} (offer ${rented.offer.ask_contract_id}, ${dollars(rented.offer.dph_total)}/h) under the same name, with ${budgetText(rented.budget)} left of the ${budgetText(state.confirmed)} the reader confirmed, replacement ${next.count} of ${MAX_REPLACEMENTS}. ssh: ${ssh} (works once the box is running).`,
    );
  }
}

/** The plan for the box that replaces `box`: its machine left out, what it cost counted as spent, one more replacement. */
function advance(state: Replace, box: Instance, reason: string, now: number): Replace {
  const machine = box.machine_id ?? state.machine;
  return {
    ...state,
    excluded:
      machine === null || state.excluded.includes(machine)
        ? state.excluded
        : [...state.excluded, machine],
    spent: state.spent + (spentOf(box, now) ?? 0),
    count: state.count + 1,
    replaces: { box: box.id ?? 0, reason },
  };
}
