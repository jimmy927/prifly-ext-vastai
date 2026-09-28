/**
 * Vast.ai boxes, on the sessions that rented them.
 *
 * A box belongs to the session whose id starts its label:
 * `s-<first 8 characters of the session id>/<name>`, e.g. `s-e5636c90/lc-box1`.
 * prifly tells every session it runs its own id, so a session can label what
 * it rents. A box without such a label is unclaimed: it shows in prifly's
 * status bar, because a rented box nobody owns is money being spent.
 *
 * Every minute this lists the account's boxes over Vast.ai's REST API
 * (`vast-api.ts`; it used to run `vastai show instances --raw`, a Python
 * start-up each time) and shows one item per box: its name and hourly rate, coloured by how busy it is — red below 20 %
 * CPU or GPU (paid for, idle), green from 80 %, amber between — and red with
 * its status when it is not running, since a stopped box still bills disk.
 *
 * `vastai`, still used to destroy a box, is this extension's own: prifly
 * builds a `.venv` from `pyproject.toml` and `uv.lock` before starting it, and
 * hands its `bin` in `api.paths`. The list reads the API key where the CLI
 * keeps it (`vastai set api-key`). Config (optional), in this folder's `config.json`:
 *   { "vastai": "/path/to/another/vastai", "refreshSeconds": 60 }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Decoration, DecorationTone, ExtensionApi, ExtensionMachine } from "./prifly-api";
import { type Instance, listInstances, readApiKeys } from "./vast-api";

/** `sshKey`: the private key your boxes accept, for the terminal a click opens. */
type Config = { vastai: string; refreshSeconds: number; sshKey: string | null };

const LABEL = /^s-([0-9a-f]{8})\/(.+)$/;
const IDLE_PCT = 20;
const BUSY_PCT = 80;

export async function activate(api: ExtensionApi): Promise<() => void> {
  const config = await readConfig(api.folder, api.paths);
  let stopped = false;
  const refresh = async () => {
    try {
      const boxes = await listInstances(await readApiKeys());
      if (!stopped) {
        show(api, boxes, config.sshKey);
        // Absent on a prifly older than "machines": the boxes still show.
        api.machines?.report(machinesOf(boxes, config.sshKey));
      }
    } catch (caught) {
      // No API key, a refused one, or offline: said in the log, and tried
      // again next minute rather than stopping the extension.
      api.log("refresh_failed", {
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  };
  // The right-click "Destroy box…" (see `decoration`): prifly has already
  // asked the reader, so the CLI's own prompt is skipped.
  api.onAction(async (key, action) => {
    if (action !== "destroy" || !/^\d+$/.test(key)) {
      throw new Error(`Unknown action ${action} on ${key}`);
    }
    await vastai(config.vastai, ["destroy", "instance", key, "-y"]);
    api.log("destroyed", { instance: key });
    void refresh();
    return `Destroyed Vast.ai box #${key}; it no longer bills.`;
  });
  await refresh();
  const timer = setInterval(() => void refresh(), config.refreshSeconds * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function readConfig(folder: string, paths: readonly string[]): Promise<Config> {
  const raw = (await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}))) as Partial<Config>;
  return {
    vastai: raw.vastai ?? Bun.which("vastai", { PATH: paths.join(":") }) ?? "vastai",
    refreshSeconds: Math.max(15, raw.refreshSeconds ?? 60),
    sshKey: raw.sshKey == null ? null : raw.sshKey.replace(/^~(?=\/)/, homedir()),
  };
}

/** Run the CLI; its stdout, or an error with the end of what it said. */
async function vastai(cli: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`vastai ${args[0] ?? ""} failed (${code}): ${err.trim().slice(0, 200)}`);
  }
  return out;
}

function show(api: ExtensionApi, boxes: readonly Instance[], sshKey: string | null): void {
  const bySession: Record<string, Decoration[]> = {};
  const unclaimed: Decoration[] = [];
  for (const box of boxes) {
    const { session, name } = ownerOf(box);
    const item = decoration(box, name, session === null, sshKey);
    if (session === null) unclaimed.push(item);
    else bySession[session] = [...(bySession[session] ?? []), item];
  }
  api.show(bySession, unclaimed);
}

/** Who rented a box and what to call it, from its `s-<session8>/<name>` label. */
function ownerOf(box: Instance): { session: string | null; name: string } {
  const label = box.label ?? "";
  const owner = LABEL.exec(label);
  return { session: owner?.[1] ?? null, name: owner?.[2] ?? (label || `#${box.id ?? "?"}`) };
}

/** Where to ssh to a box: only a running one with an address has somewhere. */
function sshTarget(box: Instance): { host: string; port: number } | null {
  const running = (box.actual_status ?? box.intended_status) === "running";
  const { ssh_host: host, ssh_port: port } = box;
  return running && host !== undefined && port !== undefined ? { host, port } : null;
}

function decoration(
  box: Instance,
  name: string,
  unclaimed: boolean,
  sshKey: string | null,
): Decoration {
  const status = box.actual_status ?? box.intended_status ?? "?";
  const rate = `$${(box.dph_total ?? 0).toFixed(2)}/h`;
  const running = status === "running";
  const target = sshTarget(box);
  return {
    key: String(box.id ?? name),
    icon: running ? "server" : "alert",
    label: `${unclaimed ? "? " : ""}${name} ${running ? rate : status}`,
    tone: running ? load(percent(box.cpu_util), percent(box.gpu_util)) : "critical",
    details: details(box, status, rate, unclaimed),
    actions: [
      {
        id: "destroy",
        label: "Destroy box…",
        confirm: `Destroy ${name} (Vast.ai #${box.id ?? "?"}, ${rate})? The box and everything on its disk are deleted, and it stops billing. This cannot be undone.`,
        destructive: true,
      },
    ],
    // A click on the box opens ssh to it in a terminal window of prifly's own.
    // accept-new: the first connection to a box trusts its key, as renting it
    // already did; a key that later changes is still refused.
    ...(target === null
      ? {}
      : {
          terminal: {
            title: `${name} — ssh root@${target.host}:${target.port}`,
            command: sshCommand(target.host, target.port, sshKey),
          },
        }),
  };
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
    unclaimed ? "Unclaimed: label it s-<session id>/<name> or destroy it." : "",
  ].filter((line) => line !== "");
}

/**
 * Each box as a machine a session can use, plus Vast.ai itself as a provider
 * it can rent more from. A claimed box is use-freely for the session whose id
 * its label carries — it rented it — and ask-first for every other session,
 * which prifly works out from `ownerSession`; an unclaimed one is ask-first
 * for all, since nobody here knows its history. Renting costs money, so the
 * provider is ask-first.
 */
function machinesOf(boxes: readonly Instance[], sshKey: string | null): ExtensionMachine[] {
  const items = boxes.map((box) => machineOf(box, sshKey));
  const provider: ExtensionMachine = {
    key: "provider",
    kind: "provider",
    label: "Vast.ai",
    trust: "ask-first",
    notes: "Rents Linux GPU or CPU boxes by the hour; read the vastai skill before renting one.",
    capabilities: [
      { name: "rent:linux-gpu", state: "present" },
      { name: "rent:linux-cpu", state: "present" },
    ],
  };
  return [...items, provider];
}

function machineOf(box: Instance, sshKey: string | null): ExtensionMachine {
  const { session, name } = ownerOf(box);
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

/**
 * ssh to a box, as the root user Vast.ai gives. With `sshKey`, that key and
 * only it: ssh's default keys are not the one a Vast.ai account registers,
 * and offering several first can use up the box's allowed attempts.
 */
function sshCommand(host: string, port: number, sshKey: string | null): string[] {
  const key = sshKey === null ? [] : ["-i", sshKey, "-o", "IdentitiesOnly=yes"];
  return [
    "ssh",
    ...key,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(port),
    `root@${host}`,
  ];
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
