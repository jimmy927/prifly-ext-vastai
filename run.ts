/** Running things: commands on a box over ssh. */

import { join } from "node:path";
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

/** Run a shell command on a box, unattended: no password prompt, a bounded wait to connect. */
export function onBox(
  target: { host: string; port: number },
  sshKey: string | null,
  command: string,
  timeoutMs: number,
  stdin?: string,
): Promise<Ran> {
  const [ssh = "ssh", ...rest] = sshCommand(target.host, target.port, sshKey);
  const argv = [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...rest, command];
  return run(argv, timeoutMs, stdin);
}
