/**
 * Vast.ai boxes, on the sessions that rented them.
 *
 * A box belongs to the session whose id starts its label, under this
 * prifly's owner: `<owner>/s-<first 8 characters of the session id>/<name>`,
 * e.g. `jimmy/s-e5636c90/lc-box1` (the older `s-e5636c90/lc-box1` still
 * counts as this owner's). prifly tells every session it runs its own id, and
 * `vastlease book` prints the whole label, so a session can label what it
 * rents. A box without such a label is unclaimed, and one of another owner —
 * another prifly on the same Vast.ai account — is that prifly's: both show in
 * prifly's status bar, because a rented box is money being spent, and neither
 * is ever enforced.
 *
 * Every minute this lists the account's boxes over Vast.ai's REST API
 * (`vast-api.ts`; it used to run `vastai show instances --raw`, a Python
 * start-up each time) and shows one item per box: its name, hourly rate and
 * lease, coloured by how busy it is — red below 20 % CPU or GPU (paid for,
 * idle), green from 80 %, amber between — and red with its status when it is
 * not running, since a stopped box still bills disk. A lease about to end
 * turns it amber, and a box with none, or past its lease, red.
 *
 * A session's box holds a lease (`leases.ts`, booked by the `vast_rent` tool),
 * and `enforce.ts` destroys the box when it has none, it ran out, or it has
 * cost its budget; with `"enforce": false`, the default, it only says what it
 * would do. Sessions rent, extend, cancel and inspect boxes only through the
 * tools this serves (`tools.ts`), and the plugin's hook refuses the CLI.
 *
 * Everything goes over Vast.ai's REST API (`vast-api.ts`), with the API key
 * where the CLI keeps it (`~/.config/vastai/vast_api_key`). Config (optional),
 * in this folder's `config.json`:
 *   { "refreshSeconds": 60, "enforce": true, "owner": "jimmy", "sshKey": "~/.ssh/vast_ed25519" }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { CREDIT_DEFAULTS, type CreditConfig } from "./credit";
import { Enforcer, type Judged } from "./enforce";
import { extend, type Lease, leasesPath, readLeases, updateLeases } from "./leases";
import { cardLoad, GpuHold } from "./load";
import {
  boxActions,
  type CreditView,
  EXTEND_HOURS,
  leaseLine,
  providerCard,
  statusOf,
} from "./machine-card";
import { readOwner } from "./owner";
import type { Decoration, ExtensionApi, ExtensionMachine } from "./prifly-api";
import { parseLabel } from "./rules";
import { sshCommand, sshTarget } from "./run";
import { makeTools } from "./tools";
import {
  destroyInstance,
  getAccount,
  type Instance,
  listInstances,
  readApiKeys,
  withKeys,
} from "./vast-api";

/**
 * `sshKey`: the private key your boxes accept, for the terminal a click opens
 * and the save and guard the leases run. `enforce`: destroy what breaks a lease.
 * `credit`: the margin kept free of the account's credit, and the runway warnings.
 */
type Config = {
  refreshSeconds: number;
  sshKey: string | null;
  enforce: boolean;
  owner: string;
  credit: CreditConfig;
};

export async function activate(api: ExtensionApi): Promise<() => void> {
  const config = await readConfig(api.folder);
  // prifly's vault entry first (absent on an older prifly), then the CLI's key files.
  const keys = () => readApiKeys(process.env, homedir(), api.vault);
  const enforcer = new Enforcer(api, config);
  const labels = new Map<number, string>();
  // The list drops a GPU sample now and then (see load.ts): the card shows the last real one.
  const gpuHold = new GpuHold();
  let stopped = false;
  let busy = false;
  // The credit is read with the boxes; a failure is logged and the boxes still show.
  const readCredit = async (
    boxes: readonly Instance[],
    leases: Parameters<Enforcer["creditRound"]>[2],
    now: number,
  ): Promise<CreditView | null> => {
    try {
      const account = await withKeys(await keys(), (key) => getAccount(key));
      const { runway, committed } = enforcer.creditRound(account, boxes, leases, now);
      return {
        credit: account.credit,
        burn: committed.burn,
        runway,
        warnHours: config.credit.warnHours,
      };
    } catch (caught) {
      api.log("credit_read_failed", {
        message: caught instanceof Error ? caught.message : String(caught),
      });
      return null;
    }
  };
  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const boxes = await listInstances(await keys());
      const now = Date.now();
      const judged = await enforcer.round(boxes, now);
      const leases = await readLeases(leasesPath(api.folder));
      const credit = await readCredit(boxes, leases, now);
      if (!stopped) {
        remember(labels, boxes);
        show(api, boxes, judged, config, gpuHold, now);
        // Absent on a prifly older than "machines": the boxes still show.
        const waiting = leases.filter((l) => l.box === null);
        api.machines?.report(machinesOf(boxes, config, judged, waiting, credit));
      }
    } catch (caught) {
      // No API key, a refused one, or offline: said in the log, and tried
      // again next minute rather than stopping the extension.
      api.log("refresh_failed", {
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      busy = false;
    }
  };
  // Absent on a prifly older than "extension tools": the boxes still show.
  api.tools?.register(
    makeTools({
      folder: api.folder,
      owner: () => readOwner(api.folder, process.env),
      sshKey: config.sshKey,
      keys,
      get: fetch,
      now: Date.now,
      sleep: Bun.sleep,
      refresh: () => void refresh(),
      log: (event, fields) => api.log(event, fields),
      features: api.features ?? [],
      credit: config.credit,
    }),
  );
  api.onAction(async (key, action) => {
    const hours = EXTEND_HOURS[action];
    if (!/^\d+$/.test(key) || (action !== "destroy" && hours === undefined)) {
      throw new Error(`Unknown action ${action} on ${key}`);
    }
    const id = Number(key);
    if (hours !== undefined) {
      // From the reader's menu: a box with no lease gets one, so it is kept.
      const label = labels.get(id) ?? "";
      const lease = await updateLeases(leasesPath(api.folder), (leases) =>
        extend(leases, { box: id }, hours, Date.now(), { box: id, label }),
      );
      api.log("extended", { instance: id, until: lease.until, by: "reader" });
      void refresh();
      return `Vast.ai box #${key} is leased until ${new Date(lease.until).toLocaleTimeString()}.`;
    }
    // "Destroy box…": prifly has already asked the reader.
    await withKeys(await keys(), (apiKey) => destroyInstance(apiKey, id));
    api.log("destroyed", { instance: key });
    void refresh();
    return `Destroyed Vast.ai box #${key}; it no longer bills.`;
  });
  await refresh();
  const timer = setInterval(() => void refresh(), config.refreshSeconds * 1000);
  return () => {
    stopped = true;
    enforcer.stop();
    clearInterval(timer);
  };
}

/** Each box's label by its id, for the menu's "Extend lease" on a box with none. */
function remember(labels: Map<number, string>, boxes: readonly Instance[]): void {
  labels.clear();
  for (const box of boxes) if (box.id !== undefined) labels.set(box.id, box.label ?? "");
}

async function readConfig(folder: string): Promise<Config> {
  const raw = (await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}))) as Partial<Config>;
  return {
    refreshSeconds: Math.max(15, raw.refreshSeconds ?? 60),
    sshKey: raw.sshKey == null ? null : raw.sshKey.replace(/^~(?=\/)/, homedir()),
    enforce: raw.enforce === true,
    owner: await readOwner(folder, process.env),
    credit: creditConfig(raw.credit),
  };
}

/** `credit` in `config.json`, each setting that is a usable number kept, the rest the defaults. */
function creditConfig(raw: Partial<CreditConfig> | undefined): CreditConfig {
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const warn = Array.isArray(raw?.warnHours)
    ? raw.warnHours.filter((h): h is number => typeof h === "number" && h > 0)
    : [];
  return {
    marginPercent: number(raw?.marginPercent, CREDIT_DEFAULTS.marginPercent),
    marginHours: number(raw?.marginHours, CREDIT_DEFAULTS.marginHours),
    horizonHours: number(raw?.horizonHours, CREDIT_DEFAULTS.horizonHours),
    warnHours: warn.length === 0 ? CREDIT_DEFAULTS.warnHours : warn,
  };
}

function show(
  api: ExtensionApi,
  boxes: readonly Instance[],
  judged: ReadonlyMap<number, Judged>,
  config: Config,
  hold: GpuHold,
  now: number,
): void {
  const bySession: Record<string, Decoration[]> = {};
  const unclaimed: Decoration[] = [];
  hold.keep(new Set(boxes.flatMap((box) => (box.id === undefined ? [] : [box.id]))));
  for (const box of boxes) {
    const { session, name } = ownerOf(box, config.owner);
    const lease = box.id === undefined ? undefined : judged.get(box.id);
    const item = decoration(box, name, session, lease, config, hold, now);
    if (session === null) unclaimed.push(item);
    else bySession[session] = [...(bySession[session] ?? []), item];
  }
  api.show(bySession, unclaimed);
}

/**
 * Which of this prifly's sessions rented a box, and what to call it, from its
 * `<owner>/s-<session8>/<name>` label (or the older `s-<session8>/<name>`). A
 * box of another owner has no session here: that prifly's session ids mean
 * nothing on this one, so it is named with its owner.
 */
function ownerOf(box: Instance, owner: string): { session: string | null; name: string } {
  const label = box.label ?? "";
  const parsed = parseLabel(label);
  if (parsed === null) return { session: null, name: label || `#${box.id ?? "?"}` };
  if (parsed.owner !== null && parsed.owner !== owner) {
    return { session: null, name: `${parsed.owner}/${parsed.name}` };
  }
  return { session: parsed.session, name: parsed.name };
}

function decoration(
  box: Instance,
  name: string,
  session: string | null,
  lease: Judged | undefined,
  config: Config,
  hold: GpuHold,
  now: number,
): Decoration {
  const status = box.actual_status ?? box.intended_status ?? "?";
  const rate = `$${(box.dph_total ?? 0).toFixed(2)}/h`;
  const running = status === "running";
  const target = sshTarget(box);
  const load = cardLoad(box, hold, now);
  const loadTone = running ? load.tone : "critical";
  const leased = lease === undefined ? null : leaseLine(lease, config.enforce);
  const unclaimed = session === null && lease?.verdict.kind !== "foreign";
  return {
    key: String(box.id ?? name),
    icon: running ? "server" : "alert",
    label: `${unclaimed ? "? " : ""}${name} ${running ? rate : status}${leased === null ? "" : ` · ${leased.short}`}`,
    tone: leased?.tone ?? loadTone,
    details: [
      ...details(box, status, rate, unclaimed, load.line),
      ...(leased === null ? [] : leased.details),
    ],
    actions: boxActions(box.id ?? "?", name, rate, lease),
    // A click on the box opens ssh to it in a terminal window of prifly's own.
    ...(target === null
      ? {}
      : {
          terminal: {
            title: `${name} — ssh root@${target.host}:${target.port}`,
            command: sshCommand(target.host, target.port, config.sshKey),
          },
        }),
  };
}

/** The hover lines of a box. */
function details(
  box: Instance,
  status: string,
  rate: string,
  unclaimed: boolean,
  loadLine: string,
): string[] {
  const running = status === "running";
  return [
    `Vast.ai #${box.id ?? "?"} · label ${box.label || "(none)"}`,
    `${status} · ${rate}${running ? "" : " — a stopped box still bills disk"}`,
    running ? loadLine : "",
    running ? `Memory ${memory(box)}` : "",
    box.ssh_host === undefined ? "" : `ssh -p ${box.ssh_port} root@${box.ssh_host}`,
    unclaimed
      ? "Unclaimed: rented by hand or by other software. Destroy it from its menu if it is not wanted."
      : "",
  ].filter((line) => line !== "");
}

/**
 * Each box as a machine a session can use, plus Vast.ai itself as a provider
 * it can rent more from. A claimed box is use-freely for the session whose id
 * its label carries — it rented it — and ask-first for every other session,
 * which prifly works out from `ownerSession`; an unclaimed one, or another
 * owner's, is ask-first for all, since nobody here knows its history. Renting costs money, so the
 * provider is ask-first.
 */
function machinesOf(
  boxes: readonly Instance[],
  config: Config,
  judged: ReadonlyMap<number, Judged>,
  waiting: readonly Lease[],
  credit: CreditView | null,
): ExtensionMachine[] {
  const items = boxes.map((box) =>
    machineOf(box, config, box.id === undefined ? undefined : judged.get(box.id)),
  );
  const provider: ExtensionMachine = {
    key: "provider",
    kind: "provider",
    label: "Vast.ai",
    trust: "ask-first",
    ...providerCard(waiting, credit),
    notes:
      "Rents Linux GPU or CPU boxes by the hour, only through the vast_offers and vast_rent tools: the reader confirms the budget of each rental. Read the vastai skill first.",
    capabilities: [
      { name: "rent:linux-gpu", state: "present" },
      { name: "rent:linux-cpu", state: "present" },
    ],
  };
  return [...items, provider];
}

function machineOf(
  box: Instance,
  { sshKey, owner, enforce }: Config,
  lease: Judged | undefined,
): ExtensionMachine {
  const { session, name } = ownerOf(box, owner);
  const running = (box.actual_status ?? box.intended_status) === "running";
  const target = sshTarget(box);
  const gpu = box.gpu_name ?? "";
  const rate = `$${(box.dph_total ?? 0).toFixed(2)}/h`;
  return {
    key: String(box.id ?? name),
    label: name,
    status: statusOf(lease, session, owner, enforce),
    actions: boxActions(box.id ?? "?", name, rate, lease),
    os: "linux",
    exec: target === null ? [] : sshCommand(target.host, target.port, sshKey),
    trust: session === null ? "ask-first" : "use-freely",
    ownerSession: session ?? "",
    notes: running ? "" : "not running — a stopped box still bills disk",
    capabilities:
      gpu === ""
        ? []
        : [{ name: "gpu", state: "present", version: gpu, detail: `${box.num_gpus ?? 1}x` }],
  };
}

function memory(box: Instance): string {
  const used = box.mem_usage;
  const limit = box.mem_limit;
  if (typeof used !== "number" || typeof limit !== "number") return "?";
  return `${used.toFixed(1)} / ${limit.toFixed(0)} GB`;
}
