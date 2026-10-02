/**
 * Carrying out the lease rules (`rules.ts`) once a minute, with each list of boxes.
 *
 * - A session's box that is due — no lease, a lease over by more than the
 *   grace, a cancelled lease, a budget spent — is saved and destroyed: `/root/.lease/save` if
 *   the box has one, again after 10 minutes if it fails, then destroyed
 *   whatever happened. Just before destroying, the lease is read again, so an
 *   extension made meanwhile saves the box.
 * - A lease about to end, one in its grace, a box not booked yet, a leased
 *   box idle for an hour and a box that has cost 90 % of its budget are told
 *   to the reader, once each.
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

import { join } from "node:path";
import { leaseOf, leasesPath, readLeases, tidy, updateLeases } from "./leases";
import type { DecorationTone, ExtensionApi } from "./prifly-api";
import {
  GRACE_MS,
  IDLE_MS,
  IdleWatch,
  judge,
  type Mine,
  parseLabel,
  span,
  type Verdict,
} from "./rules";
import { onBox, sshTarget } from "./run";
import { BUDGET_WARN, budgetText, cappedUntil, spentLine, spentOf } from "./spend";
import { destroyInstance, type Instance, readApiKeys, withKeys } from "./vast-api";

export type EnforceConfig = {
  sshKey: string | null;
  enforce: boolean;
  /** The label owner this prifly manages: see `owner.ts`. */
  owner: string;
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
export type EnforceDeps = { destroy: (id: number) => Promise<void> };

/** Destroy over REST with the account's key, as `guard.sh` does on the box. */
const restDeps: EnforceDeps = {
  destroy: async (id) => withKeys(await readApiKeys(), (key) => destroyInstance(key, id)),
};

const SAVE_MS = 10 * 60_000;
const RETRY_MS = 10 * 60_000;
/** The guard waits this much longer than the extension, so the extension goes first. */
const GUARD_MARGIN_MS = 15 * 60_000;

export class Enforcer {
  readonly #api: ExtensionApi;
  readonly #config: EnforceConfig;
  readonly #deps: EnforceDeps;
  readonly #file: string;
  readonly #idle = new IdleWatch();
  /** Notices already given, so each is said once. */
  readonly #told = new Set<string>();
  /** Boxes being saved and destroyed now. */
  readonly #taking = new Set<number>();
  /** The lease end each box's guard holds, as last written there. */
  readonly #guarded = new Map<number, number>();
  /** Boxes whose guard is being written now: ssh to a box can take a while. */
  readonly #guarding = new Set<number>();
  #stopped = false;

  constructor(api: ExtensionApi, config: EnforceConfig, deps: EnforceDeps = restDeps) {
    this.#api = api;
    this.#config = config;
    this.#deps = deps;
    this.#file = leasesPath(api.folder);
  }

  stop(): void {
    this.#stopped = true;
  }

  /** Judge every box, act on what is due, and hand back what the chips show. */
  async round(boxes: readonly Instance[], now: number): Promise<Map<number, Judged>> {
    const known = boxes.flatMap((box) =>
      box.id === undefined ? [] : [{ id: box.id, label: box.label ?? "" }],
    );
    let leases = await readLeases(this.#file);
    if (tidy(leases, known, now).changed) {
      leases = await updateLeases(this.#file, (current) => {
        const next = tidy(current, known, now).leases;
        return { leases: next, result: next };
      });
    }
    this.#idle.keep(new Set(known.map((box) => box.id)));
    const mine = this.#mine();
    const judged = new Map<number, Judged>();
    for (const box of boxes) {
      if (box.id === undefined) continue;
      const label = box.label ?? "";
      const lease = leaseOf(leases, box.id, label);
      const spent = spentOf(box, now);
      const verdict = judge(
        {
          id: box.id,
          label,
          startedAt: box.start_date === undefined ? null : box.start_date * 1000,
          spent,
        },
        lease,
        now,
        mine,
      );
      const info: Judged = {
        verdict,
        idleMs: this.#idle.observe(box.id, loadOf(box), now),
        until: lease === null ? null : cappedUntil(lease.until, box, lease.budget),
        spent,
        budget: lease?.budget ?? null,
      };
      judged.set(box.id, info);
      await this.#act(box, box.id, info);
    }
    return judged;
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
      await updateLeases(this.#file, (leases) => ({
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
    const ran = await onBox(
      target,
      this.#config.sshKey,
      "[ -x /root/.lease/save ] || exit 0; timeout 590 /root/.lease/save",
      SAVE_MS,
    );
    this.#api.log("saved", { instance: id, code: ran.code, err: ran.err.trim().slice(-200) });
    return ran.code === 0;
  }

  async #stillDue(box: Instance, id: number): Promise<boolean> {
    const lease = leaseOf(await readLeases(this.#file), id, box.label ?? "");
    const startedAt = box.start_date === undefined ? null : box.start_date * 1000;
    const now = Date.now();
    const verdict = judge(
      { id, label: box.label ?? "", startedAt, spent: spentOf(box, now) },
      lease,
      now,
      this.#mine(),
    );
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
    const script = await Bun.file(join(import.meta.dir, "guard.sh")).text();
    const grace = Math.round((GRACE_MS + GUARD_MARGIN_MS) / 1000);
    const command = [
      "set -e; d=/root/.lease; mkdir -p $d",
      "cat > $d/guard.sh; chmod 755 $d/guard.sh",
      `echo ${Math.floor(until / 1000)} > $d/until.tmp; mv $d/until.tmp $d/until`,
      `if ! kill -0 "$(cat $d/guard.pid 2>/dev/null)" 2>/dev/null; then LEASE_GRACE_SECONDS=${grace} setsid nohup sh $d/guard.sh >>$d/guard.log 2>&1 </dev/null & echo $! > $d/guard.pid; fi`,
    ].join("; ");
    const ran = await onBox(target, this.#config.sshKey, command, 60_000, script);
    if (ran.code === 0) this.#guarded.set(id, until);
    this.#api.log("guard", {
      instance: id,
      until,
      code: ran.code,
      err: ran.err.trim().slice(-200),
    });
  }
}

function nameOf(box: Instance): string {
  return parseLabel(box.label ?? "")?.name ?? `#${box.id ?? "?"}`;
}

function loadOf(box: Instance) {
  const up = box.inet_up_billed ?? null;
  const down = box.inet_down_billed ?? null;
  return {
    cpu: box.cpu_util ?? null,
    gpu: box.gpu_util ?? null,
    netKiB: up === null && down === null ? null : (up ?? 0) + (down ?? 0),
  };
}
