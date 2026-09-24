/**
 * Vast.ai boxes, on the sessions that rented them.
 *
 * A box belongs to the session whose id starts its label:
 * `s-<first 8 characters of the session id>/<name>`, e.g. `s-e5636c90/lc-box1`.
 * prifly tells every session it runs its own id, so a session can label what
 * it rents. A box without such a label is unclaimed: it shows in prifly's
 * status bar, because a rented box nobody owns is money being spent.
 *
 * Every minute this runs `vastai show instances --raw` and shows one item per
 * box: its name and hourly rate, coloured by how busy it is — red below 20 %
 * CPU or GPU (paid for, idle), green from 80 %, amber between — and red with
 * its status when it is not running, since a stopped box still bills disk.
 *
 * `vastai` is this extension's own: prifly builds a `.venv` from
 * `pyproject.toml` and `uv.lock` before starting it, and hands its `bin` in
 * `api.paths`. Config (optional), in this folder's `config.json`:
 *   { "vastai": "/path/to/another/vastai", "refreshSeconds": 60 }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Decoration, DecorationTone, ExtensionApi } from "./prifly-api";

/** `sshKey`: the private key your boxes accept, for the terminal a click opens. */
type Config = { vastai: string; refreshSeconds: number; sshKey: string | null };

/** One box, as `vastai show instances --raw` lists it — only what is used here. */
type Instance = {
  id?: number;
  label?: string | null;
  gpu_name?: string;
  num_gpus?: number;
  actual_status?: string | null;
  intended_status?: string | null;
  dph_total?: number;
  cpu_util?: number | null;
  gpu_util?: number | null;
  mem_usage?: number | null;
  mem_limit?: number | null;
  ssh_host?: string;
  ssh_port?: number;
};

const LABEL = /^s-([0-9a-f]{8})\/(.+)$/;
const IDLE_PCT = 20;
const BUSY_PCT = 80;

export async function activate(api: ExtensionApi): Promise<() => void> {
  const config = await readConfig(api.folder, api.paths);
  let stopped = false;
  const refresh = async () => {
    try {
      const boxes = await listBoxes(config.vastai);
      if (!stopped) show(api, boxes, config.sshKey);
    } catch (caught) {
      // The CLI missing, logged out or offline: said in the log, and tried
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

async function listBoxes(cli: string): Promise<Instance[]> {
  const parsed: unknown = JSON.parse(await vastai(cli, ["show", "instances", "--raw"]));
  return Array.isArray(parsed) ? (parsed as Instance[]) : [];
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
    const label = box.label ?? "";
    const owner = LABEL.exec(label);
    const item = decoration(box, owner?.[2] ?? (label || `#${box.id ?? "?"}`), owner === null, sshKey);
    const session = owner?.[1];
    if (session === undefined) unclaimed.push(item);
    else bySession[session] = [...(bySession[session] ?? []), item];
  }
  api.show(bySession, unclaimed);
}

function decoration(box: Instance, name: string, unclaimed: boolean, sshKey: string | null): Decoration {
  const status = box.actual_status ?? box.intended_status ?? "?";
  const rate = `$${(box.dph_total ?? 0).toFixed(2)}/h`;
  const running = status === "running";
  const cpu = percent(box.cpu_util);
  const gpu = percent(box.gpu_util);
  const gpus = (box.num_gpus ?? 0) > 1 ? ` ×${box.num_gpus}` : "";
  return {
    key: String(box.id ?? name),
    icon: running ? "server" : "alert",
    label: `${unclaimed ? "? " : ""}${name} ${running ? rate : status}`,
    tone: running ? load(cpu, gpu) : "critical",
    details: [
      `Vast.ai #${box.id ?? "?"} · label ${box.label || "(none)"}`,
      `${status} · ${rate}${running ? "" : " — a stopped box still bills disk"}`,
      running ? `CPU ${show0(cpu)} · GPU ${show0(gpu)}${gpus} (${box.gpu_name ?? "?"})` : "",
      running ? `Memory ${memory(box)}` : "",
      box.ssh_host === undefined ? "" : `ssh -p ${box.ssh_port} root@${box.ssh_host}`,
      unclaimed ? "Unclaimed: label it s-<session id>/<name> or destroy it." : "",
    ].filter((line) => line !== ""),
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
    ...(running && box.ssh_host !== undefined && box.ssh_port !== undefined
      ? {
          terminal: {
            title: `${name} — ssh root@${box.ssh_host}:${box.ssh_port}`,
            command: sshCommand(box.ssh_host, box.ssh_port, sshKey),
          },
        }
      : {}),
  };
}

/**
 * ssh to a box, as the root user Vast.ai gives. With `sshKey`, that key and
 * only it: ssh's default keys are not the one a Vast.ai account registers,
 * and offering several first can use up the box's allowed attempts.
 */
function sshCommand(host: string, port: number, sshKey: string | null): string[] {
  const key = sshKey === null ? [] : ["-i", sshKey, "-o", "IdentitiesOnly=yes"];
  return ["ssh", ...key, "-o", "StrictHostKeyChecking=accept-new", "-p", String(port), `root@${host}`];
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
