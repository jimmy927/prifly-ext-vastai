/** Running things: commands on a box over ssh. */

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
