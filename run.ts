/** Running things: commands on a box over ssh. */

import { join } from "node:path";
import type { ExtensionApi } from "./prifly-api";
import type { Instance } from "./vast-api";

export type Ran = { code: number; out: string; err: string };

/** Run a program with a time limit; what it printed and how it ended. */
export async function run(argv: string[], timeoutMs: number, stdin?: string): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { code, out, err };
}

/**
 * Where a box answers ssh: its Vast.ai proxy (`host`, `port`), and its own
 * address (`direct`) when the instance record maps 22/tcp, which keeps
 * working when the proxy is down.
 */
export type SshTarget = { host: string; port: number; direct?: { host: string; port: number } };

/** One way to reach a box: `exec` is the ssh argv, tried in order. Mirrors `ExtensionMachine.routes`. */
export type Route = { label: string; exec: string[] };

/** The port Vast.ai maps the box's 22/tcp to on its public address, or null when it maps none. */
function directPort(box: Instance): number | null {
  const mapped = box.ports?.["22/tcp"]?.[0]?.HostPort;
  const port = mapped === undefined ? Number.NaN : Number(mapped);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** The addresses a box has, running or not; null while Vast.ai has not given it one. */
export function addressOf(box: Instance): SshTarget | null {
  const { ssh_host: host, ssh_port: port, public_ipaddr: ip } = box;
  if (host === undefined || port === undefined) return null;
  const direct = directPort(box);
  return ip === undefined || ip === "" || direct === null
    ? { host, port }
    : { host, port, direct: { host: ip, port: direct } };
}

/** Where to ssh to a box: only a running one with an address has somewhere. */
export function sshTarget(box: Instance): SshTarget | null {
  const running = (box.actual_status ?? box.intended_status) === "running";
  return running ? addressOf(box) : null;
}

/**
 * ssh to a box, as the root user Vast.ai gives. With `sshKey`, that key and
 * only it: ssh's default keys are not the one a Vast.ai account registers,
 * and offering several first can use up the box's allowed attempts.
 * accept-new: the first connection to a box trusts its key, as renting it
 * already did; a key that later changes is still refused.
 */
export function sshCommand(host: string, port: number, sshKey: string | null): string[] {
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

/**
 * The one place routes to a box are built: its own address first when it has
 * one, then the Vast.ai proxy. The proxy died for 30 hours on 2026-10-11
 * while the boxes ran, so nothing should depend on it alone.
 */
export function routesOf(target: SshTarget, sshKey: string | null): Route[] {
  const proxy = { label: "proxy", exec: sshCommand(target.host, target.port, sshKey) };
  if (target.direct === undefined) return [proxy];
  const { host, port } = target.direct;
  return [{ label: "direct", exec: sshCommand(host, port, sshKey) }, proxy];
}

/** The routes to a running box, direct first; none while it has no address or is not running. */
export function sshRoutes(box: Instance, sshKey: string | null): Route[] {
  const target = sshTarget(box);
  return target === null ? [] : routesOf(target, sshKey);
}

/** ssh's own exit code when it cannot connect (the remote command never ran). */
const SSH_CONNECT_FAILED = 255;

/**
 * Run `command` on a box over its routes in order, moving to the next only
 * when ssh could not connect (exit 255). Any other outcome, a remote failure
 * or a timeout included, is the answer: the box was reached. A remote command
 * that itself exits 255 also moves on; that costs one repeat, not a wrong answer.
 */
export async function runOverRoutes(
  routes: readonly Route[],
  command: string,
  timeoutMs: number,
  stdin?: string,
  spawn: (argv: string[], timeoutMs: number, stdin?: string) => Promise<Ran> = run,
): Promise<Ran> {
  let last: Ran = { code: -1, out: "", err: "no ssh route to the box" };
  for (const route of routes) {
    last = await spawn(unattended(route.exec, command), timeoutMs, stdin);
    if (last.code !== SSH_CONNECT_FAILED) return last;
  }
  return last;
}

/**
 * `sshKey` from `config.json` as a path on this machine: a leading `~`, then
 * `/` or `\`, is the home folder (`homedir()`: `$HOME`, or `%USERPROFILE%` on
 * Windows); any other path, `C:\…` included, is taken as written.
 */
export function sshKeyPath(raw: string, home: string): string {
  if (raw === "~") return home;
  return /^~[/\\]/.test(raw) ? join(home, ...raw.slice(2).split(/[/\\]/)) : raw;
}

/**
 * Why the configured key file cannot be used here, or null when it exists. A
 * POSIX path on native Windows is named as such: a config written in WSL
 * (`/home/…`) points at nothing once prifly runs on Windows.
 */
export async function sshKeyProblem(
  path: string,
  platform: string = process.platform,
): Promise<string | null> {
  if (await Bun.file(path).exists()) return null;
  const posixOnWindows = platform === "win32" && path.startsWith("/");
  return posixOnWindows
    ? `sshKey ${path} is a WSL/Linux path, which does not exist on native Windows: point "sshKey" in config.json at the key on this machine, e.g. ~/.ssh/vast_ed25519 under %USERPROFILE%`
    : `sshKey ${path} does not exist on this machine: ssh to the boxes will fail until "sshKey" in config.json names the key`;
}

/** The argv that runs a shell command over `exec`, unattended: no password prompt, a bounded wait to connect. */
function unattended(exec: readonly string[], command: string): string[] {
  const [ssh = "ssh", ...rest] = exec;
  return [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...rest, command];
}

/** Run a shell command on a box, unattended, direct first and over the proxy when that cannot connect. */
export function onBox(
  target: SshTarget,
  sshKey: string | null,
  command: string,
  timeoutMs: number,
  stdin?: string,
): Promise<Ran> {
  return runOverRoutes(routesOf(target, sshKey), command, timeoutMs, stdin);
}

/** prifly's vault entry for the key the boxes accept: the manifest's `vault` names it. */
export const VAULT_SSH_ENTRY = "vast-ssh";
/** The longest prifly lets a vault ssh run. */
const VAULT_MAX_MS = 600_000;

/**
 * `command` with `stdin` carried in it, for a vault ssh, which takes no
 * stdin: base64 holds no quote or `$`, and the box decodes it into the
 * command's stdin.
 */
export function withStdin(command: string, stdin: string): string {
  return `echo ${Buffer.from(stdin).toString("base64")} | base64 -d | { ${command}; }`;
}

/**
 * `onBox` with the key in prifly's vault, where this prifly has "vault-ssh":
 * prifly runs ssh with the `vast-ssh` entry handed over, and the extension
 * neither sees the key nor passes an `-i` of its own. When the vault says no
 * (no such entry, not an ssh-key, not at level 1), that is logged once and
 * the command runs as before, with the configured `sshKey` (or ssh's own
 * keys when there is none). On an older prifly, plain `onBox` (`plain`, which
 * a test replaces).
 */
export function boxRunner(
  api: Pick<ExtensionApi, "features" | "vault" | "log">,
  plain: typeof onBox = onBox,
): typeof onBox {
  const vault = api.vault;
  if (!api.features?.includes("vault-ssh") || vault?.ssh === undefined) return plain;
  const said = new Set<string>();
  return async (target, sshKey, command, timeoutMs, stdin) => {
    let refusal: string | undefined;
    const viaVault = async (argv: string[]): Promise<Ran> => {
      if (refusal !== undefined) return { code: -1, out: "", err: refusal };
      const ran = await vault.ssh?.(VAULT_SSH_ENTRY, argv, {
        timeoutMs: Math.min(timeoutMs, VAULT_MAX_MS),
      });
      if (ran?.ok) return { code: ran.exitCode ?? -1, out: ran.stdout, err: ran.stderr };
      refusal = ran?.message ?? "vault ssh is not there";
      return { code: -1, out: "", err: refusal };
    };
    const ran = await runOverRoutes(
      routesOf(target, null),
      stdin === undefined ? command : withStdin(command, stdin),
      timeoutMs,
      undefined,
      viaVault,
    );
    if (refusal === undefined) return ran;
    const message = refusal;
    if (!said.has(message)) {
      said.add(message);
      api.log("vault_ssh_refused", { entry: VAULT_SSH_ENTRY, message, fallback: sshKey });
    }
    return plain(target, sshKey, command, timeoutMs, stdin);
  };
}
