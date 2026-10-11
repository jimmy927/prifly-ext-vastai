/**
 * Carrying out the lease rules (`rules.ts`) once a minute, with each list of boxes.
 *
 * - A session's box that is due — no lease, a lease over by more than the
 *   grace, a cancelled lease, a budget spent, the host's end date less than
 *   30 minutes away (Vast.ai stops the box then) — is saved and destroyed: `/root/.lease/save` if
 *   the box has one, again after 10 minutes if it fails, then destroyed
 *   whatever happened. Just before destroying, the lease is read again, so an
 *   extension made meanwhile saves the box.
 * - A lease about to end, one in its grace, a box not booked yet, a leased
 *   box idle for an hour and a box that has cost 90 % of its budget are told
 *   to the reader, once each.
 * - A box that turns out broken (ssh refused, a bad-modes log, stuck in
 *   created) is cancelled and replaced from the rent's own card: `broken.ts`.
 * - Every leased box that is running gets the on-box guard (`guard.sh`) and
 *   its lease's end, so it destroys itself when prifly is not running.
 *
 * With `enforce` off (the default) nothing is destroyed and no guard is
 * installed: every step is only said — "would destroy lc-box3".
 *
 * Only this owner's boxes are acted on, and only those of a session the host
 * knows (`api.sessions()`, past ones too): another owner's box is left alone,
 * and one of an unknown session is told about once, never destroyed or guarded.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type BrokenDeps, BrokenWatch, LOG_TAIL } from "./broken";
import {
  type Account,
  burnOf,
  CREDIT_DEFAULTS,
  type CreditConfig,
  committedOf,
  runwayHours,
} from "./credit";
import { type Lease, leaseOf, readLeases, tidy, updateLeases } from "./leases";
import { readLoad } from "./load";
import type { DecorationTone, ExtensionApi } from "./prifly-api";
import {
  type BoxFacts,
  GRACE_MS,
  hostEnd,
  IDLE_MS,
  IdleWatch,
  judge,
  type Load,
  type Mine,
  parseLabel,
  span,
  type Verdict,
} from "./rules";
import { boxRunner, type onBox, sshTarget } from "./run";
import { BUDGET_WARN, budgetText, cappedUntil, dollars, spentLine, spentOf } from "./spend";
import type { Store } from "./store";
import {
  destroyInstance,
  type Fetch,
  type Instance,
  readApiKeys,
  requestLogs,
  withKeys,
} from "./vast-api";

export type EnforceConfig = {
  sshKey: string | null;
  enforce: boolean;
  /** The label owner this prifly manages: see `owner.ts`. */
  owner: string;
  /** The margin and the runway warnings: `credit` in `config.json`. */
  credit?: CreditConfig;
};

/**
 * What the chips show of each box: its verdict, how long it has been idle, its
 * lease's end (held to the hour its budget runs out), and what it has cost of
 * its budget.
 */
export type Judged = {
  verdict: Verdict;
  idleMs: number;
  until: number | null;
  spent: number | null;
  budget: number | null;
};

/** What the enforcer does to Vast.ai, replaceable so a test destroys nothing. */
export type EnforceDeps = BrokenDeps & {
  destroy: (id: number) => Promise<void>;
  /** Run a command on a box over ssh; the real one (`boxRunner`) when left out. */
  onBox?: typeof onBox;
  /** The on-box guard's source; `guard.sh` beside this file when left out. */
  guardScript?: () => Promise<string>;
};

/**
 * Destroy over REST with the account's key, as `guard.sh` does on the box:
 * prifly's vault entry first, when `vault` is there, then the CLI's key files.
 */
export function restDeps(vault: ExtensionApi["vault"], get: Fetch = fetch): EnforceDeps {
  const keys = () => readApiKeys(process.env, homedir(), vault);
  return {
    destroy: async (id) => withKeys(await keys(), (key) => destroyInstance(key, id, get)),
    logs: async (id) => withKeys(await keys(), (key) => requestLogs(key, id, LOG_TAIL, get)),
    keys,
    get,
  };
}

const SAVE_MS = 10 * 60_000;
const RETRY_MS = 10 * 60_000;
/** The guard waits this much longer than the extension, so the extension goes first. */
const GUARD_MARGIN_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
/** The credit rising by more than this between two rounds is a top-up: billing only ever lowers it. */
const TOP_UP_DOLLARS = 0.5;

export class Enforcer {
  readonly #api: ExtensionApi;
  readonly #config: EnforceConfig;
  readonly #deps: EnforceDeps;
  readonly #store: Store;
  /** ssh to a box: the vault's key where prifly has "vault-ssh" (`boxRunner`), else `sshKey`. */
  readonly #onBox: typeof onBox;
  readonly #idle = new IdleWatch();
  /** Notices already given, so each is said once. */
  readonly #told = new Set<string>();
  /** Boxes being saved and destroyed now. */
  readonly #taking = new Set<number>();
  /** The lease end each box's guard holds, as last written there. */
  readonly #guarded = new Map<number, number>();
  /** Boxes whose guard is being written now: ssh to a box can take a while. */
  readonly #guarding = new Set<number>();
  /** Broken boxes: found and replaced from the card the reader confirmed. */
  readonly #broken: BrokenWatch;
  #stopped = false;
  /** The credit at the last round, to see a top-up. */
  #lastCredit: number | null = null;

  constructor(
    api: ExtensionApi,
    store: Store,
    config: EnforceConfig,
    deps: EnforceDeps = restDeps(api.vault),
  ) {
    this.#api = api;
    this.#config = config;
    this.#deps = deps;
    this.#store = store;
    this.#onBox = deps.onBox ?? boxRunner(api);
    this.#broken = new BrokenWatch({
      api,
      enforce: config.enforce,
      sshKey: config.sshKey,
      deps,
      onBox: (...args) => this.#onBox(...args),
      tell: (key, text, tone, session) => this.#tell(key, text, tone, session),
      store,
    });
  }

  get #credit(): CreditConfig {
    return this.#config.credit ?? CREDIT_DEFAULTS;
  }

  stop(): void {
    this.#stopped = true;
  }

  /** Wait for the probes and replacements the last rounds started. */
  settled(): Promise<void> {
    return this.#broken.settled();
  }

  /** Judge every box, act on what is due, and hand back what the chips show. */
  async round(boxes: readonly Instance[], now: number): Promise<Map<number, Judged>> {
    const known = boxes.flatMap((box) =>
      box.id === undefined ? [] : [{ id: box.id, label: box.label ?? "" }],
    );
    // A store that cannot be read throws here, and the round with it: no box
    // is judged lease-less for want of its leases.
    let leases = await readLeases(this.#store);
    if (tidy(leases, known, now).changed) {
      leases = await updateLeases(this.#store, (current) => {
        const next = tidy(current, known, now).leases;
        return { leases: next, result: next };
      });
    }
    const live = new Set(known.map((box) => box.id));
    this.#idle.keep(live);
    this.#broken.keep(live);
    const mine = this.#mine();
    const judged = new Map<number, Judged>();
    for (const box of boxes) {
      if (box.id === undefined) continue;
      const label = box.label ?? "";
      const lease = leaseOf(leases, box.id, label);
      const spent = spentOf(box, now);
      const verdict = judge(factsOf(box, box.id, spent), lease, now, mine);
      const info: Judged = {
        verdict,
        idleMs: this.#idle.observe(box.id, loadOf(box), now),
        until: lease === null ? null : cappedUntil(lease.until, box, lease.budget),
        spent,
        budget: lease?.budget ?? null,
      };
      judged.set(box.id, info);
      await this.#act(box, box.id, info);
      this.#broken.watch(box, lease, verdict, now);
    }
    return judged;
  }

  /**
   * Watch the account's credit against what bills on it: tell the reader once
   * when the runway falls under each of `warnHours`, and once per budget when a
   * box's budget runs past the point the credit runs out. A top-up (the credit
   * going up) is told, and the warnings may be given again. Only warned: Vast.ai's
   * own auto-stop still acts at the threshold. Hands back what the provider card shows.
   */
  creditRound(account: Account, boxes: readonly Instance[], leases: readonly Lease[], now: number) {
    const committed = committedOf(boxes, leases, now, this.#credit, {});
    const runway = runwayHours(account, committed.burn);
    this.#seeTopUp(account.credit, runway);
    const ends = now + runway * HOUR_MS;
    const lowest = [...this.#credit.warnHours]
      .sort((a, b) => a - b)
      .find((hours) => runway < hours);
    if (lowest !== undefined) {
      const text = `Vast credit ${dollars(account.credit)} lasts about ${runwayText(runway)} at the account's burn of ${dollars(committed.burn)}/h (until ${clockOf(ends)}). When it reaches $0, Vast stops every box on the account. Top up at console.vast.ai → Billing.`;
      const tone = lowest <= Math.min(...this.#credit.warnHours) ? "critical" : "warning";
      for (const session of this.#creditSessions(boxes))
        this.#tell(`credit:${lowest}:${session ?? ""}`, text, tone, session);
    }
    for (const box of boxes) {
      const item = this.#shortOf(box, leases, now, runway);
      if (item === null) continue;
      this.#tell(
        `credit-short:${item.id}:${item.budget}`,
        `${item.name} needs ${dollars(item.rest)} more to reach its budget (${span(item.restHours * HOUR_MS)}), but the Vast credit runs out in about ${runwayText(runway)} (${clockOf(ends)}) at the account's burn. Top up at console.vast.ai → Billing before then, or Vast stops every box on the account.`,
        "warning",
        item.session,
      );
    }
    return { account, committed, runway };
  }

  /** A top-up: the credit went up since the last round. Told when a warning was given, and the warnings may come again. */
  #seeTopUp(credit: number, runway: number): void {
    const last = this.#lastCredit;
    this.#lastCredit = credit;
    if (last === null || credit <= last + TOP_UP_DOLLARS) return;
    const warned = [...this.#told].filter((key) => key.startsWith("credit"));
    for (const key of warned) this.#told.delete(key);
    this.#api.log("credit_topped_up", { from: last, to: credit });
    if (warned.length === 0) return;
    this.#tell(
      `credit-up:${credit}`,
      `Vast credit topped up to ${dollars(credit)}: it now lasts ${runwayText(runway)} at the account's burn.`,
      "info",
      undefined,
    );
  }

  /** The sessions of this prifly's running boxes, or the status bar alone when it has none. */
  #creditSessions(boxes: readonly Instance[]): (string | undefined)[] {
    const sessions = new Set<string>();
    for (const box of boxes) {
      const parsed = parseLabel(box.label ?? "");
      if (parsed === null || (parsed.owner !== null && parsed.owner !== this.#config.owner))
        continue;
      if (burnOf(box) > 0) sessions.add(parsed.session);
    }
    return sessions.size === 0 ? [undefined] : [...sessions];
  }

  /** A box of this prifly whose budget runs on past the credit's end, or null. */
  #shortOf(box: Instance, leases: readonly Lease[], now: number, runway: number) {
    const parsed = parseLabel(box.label ?? "");
    if (box.id === undefined || parsed === null) return null;
    if (parsed.owner !== null && parsed.owner !== this.#config.owner) return null;
    const lease = leaseOf(leases, box.id, box.label ?? "");
    const spent = spentOf(box, now);
    const rate = box.dph_total ?? 0;
    if (lease?.budget == null || spent === null || rate <= 0 || burnOf(box) <= 0) return null;
    const rest = lease.budget - spent;
    const restHours = rest / rate;
    if (rest <= 0 || restHours <= runway) return null;
    return {
      id: box.id,
      name: parsed.name,
      session: parsed.session,
      budget: lease.budget,
      rest,
      restHours,
    };
  }

  /** This prifly's owner and every session its host knows, read afresh each time. */
  #mine(): Mine {
    return { owner: this.#config.owner, sessions: this.#api.sessions().map((s) => s.id) };
  }

  async #act(box: Instance, id: number, { verdict, idleMs, until, spent, budget }: Judged) {
    if (verdict.kind === "unmanaged" || verdict.kind === "foreign") return;
    const name = nameOf(box);
    if (verdict.kind === "stranger") {
      this.#tell(
        `${id}:stranger`,
        `${name} is labelled for session ${verdict.session}, which is not this prifly's session: it is never destroyed here.`,
        "warning",
        undefined,
      );
      return;
    }
    const session = parseLabel(box.label ?? "")?.session;
    const tell = (key: string, text: string, tone: DecorationTone) =>
      this.#tell(`${id}:${key}`, text, tone, session);
    switch (verdict.kind) {
      case "unbooked":
        tell(
          "unbooked",
          `${name} has no lease and is destroyed in ${span(verdict.leftMs)}: Extend lease on its menu keeps it.`,
          "critical",
        );
        break;
      case "ending":
        tell(
          `ending:${until}`,
          `${name}'s lease ends in ${span(verdict.leftMs)}: vast_extend adds time, or it is destroyed ${span(GRACE_MS)} after.`,
          "warning",
        );
        break;
      case "grace":
        tell(
          `grace:${until}`,
          `${name}'s lease is over: it is saved and destroyed in ${span(verdict.leftMs)} unless extended.`,
          "critical",
        );
        break;
      case "due":
        if (this.#config.enforce) void this.#takeDown(box, id, verdict.reason);
        else
          tell(
            `would:${verdict.reason}`,
            `Would destroy ${name} (${verdict.reason}) — lease enforcement is off, so it is left running.`,
            "warning",
          );
        break;
      default:
        break;
    }
    if (budget !== null && spent !== null && spent >= budget * BUDGET_WARN && spent < budget) {
      // Once for each budget: a raised one is told again when it is nearly spent.
      tell(
        `budget:${budget}`,
        `${name} has cost ${spentLine(spent, budget)}: at ${budgetText(budget)} it is saved and destroyed. vast_extend asks the reader to raise the budget.`,
        "warning",
      );
    }
    // Said once for each stretch of idleness: a box that works again may be told again later.
    if (idleMs < IDLE_MS) this.#told.delete(`${id}:idle`);
    else if (verdict.kind === "leased" || verdict.kind === "ending") {
      tell(
        "idle",
        `${name} has done nothing for ${span(idleMs)} but its lease runs on: vast_cancel ${name} if it is finished.`,
        "warning",
      );
    }
    if (until !== null && verdict.kind !== "due" && this.#config.enforce) {
      void this.#guard(box, id, until);
    }
  }

  #tell(key: string, text: string, tone: DecorationTone, session: string | undefined): void {
    if (this.#told.has(key)) return;
    this.#told.add(key);
    this.#api.log("notice", { key, text });
    this.#api.notify?.(text, { tone, ...(session === undefined ? {} : { session }) });
  }

  /** Save the box, once more after 10 minutes if that fails, then destroy it — unless it was extended meanwhile. */
  async #takeDown(box: Instance, id: number, reason: string): Promise<void> {
    if (this.#taking.has(id)) return;
    this.#taking.add(id);
    const name = nameOf(box);
    try {
      this.#tell(
        `${id}:taking`,
        `Saving and destroying ${name} (${reason}).`,
        "critical",
        undefined,
      );
      if (!(await this.#save(box, id)) && !this.#stopped) {
        this.#api.log("save_failed", { instance: id, attempt: 1 });
        await Bun.sleep(RETRY_MS);
        if (this.#stopped || !(await this.#stillDue(box, id))) return;
        if (!(await this.#save(box, id)))
          this.#api.log("save_failed", { instance: id, attempt: 2 });
      }
      if (this.#stopped || !(await this.#stillDue(box, id))) return;
      await this.#deps.destroy(id);
      await updateLeases(this.#store, (leases) => ({
        leases: leases.filter((lease) => lease.box !== id),
        result: null,
      }));
      this.#api.log("destroyed", { instance: id, reason });
      this.#tell(
        `${id}:destroyed`,
        `Destroyed ${name} (${reason}); it no longer bills.`,
        "info",
        undefined,
      );
    } catch (caught) {
      this.#api.log("take_down_failed", {
        instance: id,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      this.#taking.delete(id);
    }
  }

  /** Run the box's own save hook; true when it has none, or it succeeded. */
  async #save(box: Instance, id: number): Promise<boolean> {
    const target = sshTarget(box);
    // A box that is not running cannot be reached to save; there is nothing to wait for.
    if (target === null) return true;
    const ran = await this.#onBox(
      target,
      this.#config.sshKey,
      "[ -x /root/.lease/save ] || exit 0; timeout 590 /root/.lease/save",
      SAVE_MS,
    );
    this.#api.log("saved", { instance: id, code: ran.code, err: ran.err.trim().slice(-200) });
    return ran.code === 0;
  }

  async #stillDue(box: Instance, id: number): Promise<boolean> {
    const lease = leaseOf(await readLeases(this.#store), id, box.label ?? "");
    const now = Date.now();
    const verdict = judge(factsOf(box, id, spentOf(box, now)), lease, now, this.#mine());
    return verdict.kind === "due";
  }

  /** Install the on-box guard if need be, and give it the lease's end. */
  async #guard(box: Instance, id: number, until: number): Promise<void> {
    const target = sshTarget(box);
    if (target === null || this.#guarded.get(id) === until || this.#guarding.has(id)) return;
    this.#guarding.add(id);
    try {
      await this.#writeGuard(target, id, until);
    } finally {
      this.#guarding.delete(id);
    }
  }

  async #writeGuard(target: { host: string; port: number }, id: number, until: number) {
    // LF only: a checkout made with CRLF (Windows' autocrlf) would break /bin/sh on the box.
    const read =
      this.#deps.guardScript ?? (() => Bun.file(join(import.meta.dir, "guard.sh")).text());
    const script = (await read()).replace(/\r\n/g, "\n");
    const grace = Math.round((GRACE_MS + GUARD_MARGIN_MS) / 1000);
    const command = [
      "set -e; d=/root/.lease; mkdir -p $d",
      "cat > $d/guard.sh; chmod 755 $d/guard.sh",
      `echo ${Math.floor(until / 1000)} > $d/until.tmp; mv $d/until.tmp $d/until`,
      `if ! kill -0 "$(cat $d/guard.pid 2>/dev/null)" 2>/dev/null; then LEASE_GRACE_SECONDS=${grace} setsid nohup sh $d/guard.sh >>$d/guard.log 2>&1 </dev/null & echo $! > $d/guard.pid; fi`,
    ].join("; ");
    const ran = await this.#onBox(target, this.#config.sshKey, command, 60_000, script);
    if (ran.code === 0) this.#guarded.set(id, until);
    this.#api.log("guard", {
      instance: id,
      until,
      code: ran.code,
      err: ran.err.trim().slice(-200),
    });
  }
}

/** What the rules need of a box: its label, start, cost so far and the host's end date. */
function factsOf(box: Instance, id: number, spent: number | null): BoxFacts {
  return {
    id,
    label: box.label ?? "",
    startedAt: box.start_date === undefined ? null : box.start_date * 1000,
    spent,
    endsAt: hostEnd(box),
  };
}

/** "11h 36m", or "as long as nothing bills". */
function runwayText(hours: number): string {
  return Number.isFinite(hours) ? span(hours * HOUR_MS) : "as long as nothing bills";
}

/** "07:10": the time of day, as the reader's clock shows it. */
function clockOf(epoch: number): string {
  return Number.isFinite(epoch)
    ? new Date(epoch).toLocaleTimeString([], { timeStyle: "short" })
    : "never";
}

function nameOf(box: Instance): string {
  return parseLabel(box.label ?? "")?.name ?? `#${box.id ?? "?"}`;
}

export function loadOf(box: Instance): Load {
  const { coresBusy, gpu } = readLoad(box);
  const up = box.inet_up_billed ?? null;
  const down = box.inet_down_billed ?? null;
  return {
    coresBusy,
    gpu,
    netKiB: up === null && down === null ? null : (up ?? 0) + (down ?? 0),
  };
}
