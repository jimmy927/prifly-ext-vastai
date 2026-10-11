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

/** Where to ssh to a box: only a running one with an address has somewhere. */
export function sshTarget(box: Instance): { host: string; port: number } | null {
  const running = (box.actual_status ?? box.intended_status) === "running";
  const { ssh_host: host, ssh_port: port } = box;
  return running && host !== undefined && port !== undefined ? { host, port } : null;
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

/** The argv that runs a shell command on a box, unattended: no password prompt, a bounded wait to connect. */
function boxArgv(
  target: { host: string; port: number },
  sshKey: string | null,
  command: string,
): string[] {
  const [ssh = "ssh", ...rest] = sshCommand(target.host, target.port, sshKey);
  return [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...rest, command];
}

/** Run a shell command on a box, unattended: no password prompt, a bounded wait to connect. */
export function onBox(
  target: { host: string; port: number },
  sshKey: string | null,
  command: string,
  timeoutMs: number,
  stdin?: string,
): Promise<Ran> {
  return run(boxArgv(target, sshKey, command), timeoutMs, stdin);
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
    const argv = boxArgv(target, null, stdin === undefined ? command : withStdin(command, stdin));
    const ran = await vault.ssh?.(VAULT_SSH_ENTRY, argv, {
      timeoutMs: Math.min(timeoutMs, VAULT_MAX_MS),
    });
    if (ran?.ok) return { code: ran.exitCode ?? -1, out: ran.stdout, err: ran.stderr };
    const message = ran?.message ?? "vault ssh is not there";
    if (!said.has(message)) {
      said.add(message);
      api.log("vault_ssh_refused", { entry: VAULT_SSH_ENTRY, message, fallback: sshKey });
    }
    return plain(target, sshKey, command, timeoutMs, stdin);
  };
}
