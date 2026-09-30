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
 * A session's box holds a lease (`leases.ts`, booked with `vastlease`), and
 * `enforce.ts` destroys the box when it has none or it ran out; with
 * `"enforce": false`, the default, it only says what it would do.
 *
 * `vastai`, still used to destroy a box, is this extension's own: prifly
 * builds a `.venv` from `pyproject.toml` and `uv.lock` before starting it, and
 * hands its `bin` in `api.paths`. The list reads the API key where the CLI
 * keeps it (`vastai set api-key`). Config (optional), in this folder's `config.json`:
 *   { "vastai": "/path/to/another/vastai", "refreshSeconds": 60, "enforce": true, "owner": "jimmy" }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Enforcer, type Judged } from "./enforce";
import { extend, leasesPath, updateLeases } from "./leases";
import { readOwner } from "./owner";
import type { Decoration, DecorationTone, ExtensionApi, ExtensionMachine } from "./prifly-api";
import { parseLabel, span } from "./rules";
import { sshCommand, sshTarget, vastai } from "./run";
import { type Instance, listInstances, readApiKeys } from "./vast-api";

/**
 * `sshKey`: the private key your boxes accept, for the terminal a click opens
 * and the save and guard the leases run. `enforce`: destroy what breaks a lease.
 */
type Config = {
  vastai: string;
  refreshSeconds: number;
  sshKey: string | null;
  enforce: boolean;
  owner: string;
};

const IDLE_PCT = 20;
const BUSY_PCT = 80;
/** The chip menu's "Extend lease" choices, in hours. */
const EXTEND_HOURS: Record<string, number> = { extend1: 1, extend4: 4 };

export async function activate(api: ExtensionApi): Promise<() => void> {
  const config = await readConfig(api.folder, api.paths);
  const enforcer = new Enforcer(api, config);
  const labels = new Map<number, string>();
  let stopped = false;
  let busy = false;
  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const boxes = await listInstances(await readApiKeys());
      const judged = await enforcer.round(boxes, Date.now());
      if (!stopped) {
        remember(labels, boxes);
        show(api, boxes, judged, config);
        // Absent on a prifly older than "machines": the boxes still show.
        api.machines?.report(machinesOf(boxes, config));
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
    // "Destroy box…": prifly has already asked the reader, so the CLI's own prompt is skipped.
    await vastai(config.vastai, ["destroy", "instance", key, "-y"]);
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

async function readConfig(folder: string, paths: readonly string[]): Promise<Config> {
  const raw = (await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}))) as Partial<Config>;
  return {
    vastai: raw.vastai ?? Bun.which("vastai", { PATH: paths.join(":") }) ?? "vastai",
    refreshSeconds: Math.max(15, raw.refreshSeconds ?? 60),
    sshKey: raw.sshKey == null ? null : raw.sshKey.replace(/^~(?=\/)/, homedir()),
    enforce: raw.enforce === true,
    owner: await readOwner(folder, process.env),
  };
}

function show(
  api: ExtensionApi,
  boxes: readonly Instance[],
  judged: ReadonlyMap<number, Judged>,
  config: Config,
): void {
  const bySession: Record<string, Decoration[]> = {};
  const unclaimed: Decoration[] = [];
  for (const box of boxes) {
    const { session, name } = ownerOf(box, config.owner);
    const lease = box.id === undefined ? undefined : judged.get(box.id);
    const item = decoration(box, name, session, lease, config);
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

/** Whether the lease rules act on a box: this owner's, from a session this prifly knows. */
function isManaged(lease: Judged | undefined): boolean {
  const kind = lease?.verdict.kind;
  return kind !== undefined && kind !== "unmanaged" && kind !== "foreign" && kind !== "stranger";
}

function decoration(
  box: Instance,
  name: string,
  session: string | null,
  lease: Judged | undefined,
  config: Config,
): Decoration {
  const status = box.actual_status ?? box.intended_status ?? "?";
  const rate = `$${(box.dph_total ?? 0).toFixed(2)}/h`;
  const running = status === "running";
  const target = sshTarget(box);
  const loadTone = running ? load(percent(box.cpu_util), percent(box.gpu_util)) : "critical";
  const leased = lease === undefined ? null : leaseLine(lease, config.enforce);
  const unclaimed = session === null && lease?.verdict.kind !== "foreign";
  return {
    key: String(box.id ?? name),
    icon: running ? "server" : "alert",
    label: `${unclaimed ? "? " : ""}${name} ${running ? rate : status}${leased === null ? "" : ` · ${leased.short}`}`,
    tone: leased?.tone ?? loadTone,
    details: [...details(box, status, rate, unclaimed), ...(leased === null ? [] : leased.details)],
    actions: [
      ...(!isManaged(lease)
        ? []
        : [
            { id: "extend1", label: "Extend lease by 1 hour" },
            { id: "extend4", label: "Extend lease by 4 hours" },
          ]),
      {
        id: "destroy",
        label: "Destroy box…",
        confirm: `Destroy ${name} (Vast.ai #${box.id ?? "?"}, ${rate})? The box and everything on its disk are deleted, and it stops billing. This cannot be undone.`,
        destructive: true,
      },
    ],
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

/**
 * A session's box's lease, for its chip: a few words, a colour when the lease
 * asks for attention (null leaves the load's colour), and hover lines.
 */
function leaseLine(
  { verdict, idleMs, until }: Judged,
  enforce: boolean,
): { short: string; tone: DecorationTone | null; details: string[] } | null {
  const ends = until === null ? "" : new Date(until).toLocaleTimeString([], { timeStyle: "short" });
  const idle = idleMs >= 60 * 60_000 ? [`Idle for ${span(idleMs)} (CPU, GPU and network)`] : [];
  const off = enforce ? [] : ["Lease enforcement is off: nothing is destroyed."];
  switch (verdict.kind) {
    case "unmanaged":
      return null;
    case "foreign":
      return {
        short: "other prifly",
        tone: null,
        details: [`Another prifly's box (owner ${verdict.owner}): never enforced here`],
      };
    case "stranger":
      return {
        short: "not ours",
        tone: "warning",
        details: [
          `Session ${verdict.session} is not this prifly's session: never destroyed or guarded here`,
        ],
      };
    case "leased":
      return {
        short: span(verdict.leftMs),
        tone: null,
        details: [`Leased until ${ends} (${span(verdict.leftMs)} left)`, ...idle],
      };
    case "ending":
      return {
        short: `${span(verdict.leftMs)} left`,
        tone: "warning",
        details: [`Lease ends ${ends}: extend it or the box is destroyed`, ...idle],
      };
    case "grace":
      return {
        short: "lease over",
        tone: "critical",
        details: [
          `Lease ended ${ends}: destroyed in ${span(verdict.leftMs)} unless extended`,
          ...off,
        ],
      };
    case "unbooked":
      return {
        short: "no lease",
        tone: "critical",
        details: [`No lease: destroyed in ${span(verdict.leftMs)} unless booked`, ...off],
      };
    case "due":
      return {
        short: enforce ? "destroying" : "no lease",
        tone: "critical",
        details: [
          `${enforce ? "Being saved and destroyed" : "Would be destroyed"}: ${verdict.reason}`,
          ...off,
        ],
      };
    default:
      return null;
  }
}

/** The hover lines of a box. */
function details(box: Instance, status: string, rate: string, unclaimed: boolean): string[] {
  const running = status === "running";
  const gpus = (box.num_gpus ?? 0) > 1 ? ` ×${box.num_gpus}` : "";
  const cpu = show0(percent(box.cpu_util));
  const gpu = show0(percent(box.gpu_util));
  return [
    `Vast.ai #${box.id ?? "?"} · label ${box.label || "(none)"}`,
    `${status} · ${rate}${running ? "" : " — a stopped box still bills disk"}`,
    running ? `CPU ${cpu} · GPU ${gpu}${gpus} (${box.gpu_name ?? "?"})` : "",
    running ? `Memory ${memory(box)}` : "",
    box.ssh_host === undefined ? "" : `ssh -p ${box.ssh_port} root@${box.ssh_host}`,
    unclaimed ? "Unclaimed: label it <owner>/s-<session8>/<name> or destroy it." : "",
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
function machinesOf(boxes: readonly Instance[], config: Config): ExtensionMachine[] {
  const items = boxes.map((box) => machineOf(box, config));
  const provider: ExtensionMachine = {
    key: "provider",
    kind: "provider",
    label: "Vast.ai",
    trust: "ask-first",
    notes:
      "Rents Linux GPU or CPU boxes by the hour; read the vastai skill before renting one, and book its lease with `vastlease book` first.",
    capabilities: [
      { name: "rent:linux-gpu", state: "present" },
      { name: "rent:linux-cpu", state: "present" },
    ],
  };
  return [...items, provider];
}

function machineOf(box: Instance, { sshKey, owner }: Config): ExtensionMachine {
  const { session, name } = ownerOf(box, owner);
  const running = (box.actual_status ?? box.intended_status) === "running";
  const target = sshTarget(box);
  const gpu = box.gpu_name ?? "";
  return {
    key: String(box.id ?? name),
    label: name,
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

function percent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function show0(value: number | null): string {
  return value === null ? "?" : `${value} %`;
}

/** A rented box is paid to work: idle red, busy green, amber between. */
function load(cpu: number | null, gpu: number | null): DecorationTone {
  const readings = [cpu, gpu].filter((value): value is number => value !== null);
  if (readings.length === 0) return "muted";
  const peak = Math.max(...readings);
  if (peak < IDLE_PCT) return "critical";
  return peak >= BUSY_PCT ? "good" : "warning";
}

function memory(box: Instance): string {
  const used = box.mem_usage;
  const limit = box.mem_limit;
  if (typeof used !== "number" || typeof limit !== "number") return "?";
  return `${used.toFixed(1)} / ${limit.toFixed(0)} GB`;
}
