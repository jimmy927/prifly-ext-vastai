import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshKeyPath, sshKeyProblem } from "../run";

const HOME = join(tmpdir(), "home");

test("a key under ~ is under the home folder, written with / or \\", () => {
  expect(sshKeyPath("~/.ssh/vast_ed25519", HOME)).toBe(join(HOME, ".ssh", "vast_ed25519"));
  expect(sshKeyPath("~\\.ssh\\vast_ed25519", HOME)).toBe(join(HOME, ".ssh", "vast_ed25519"));
  expect(sshKeyPath("~", HOME)).toBe(HOME);
});

test("any other key path is taken as written", () => {
  expect(sshKeyPath("C:\\Users\\jimmy\\.ssh\\vast_ed25519", HOME)).toBe(
    "C:\\Users\\jimmy\\.ssh\\vast_ed25519",
  );
  expect(sshKeyPath("/home/jimmy/.ssh/vast_ed25519", HOME)).toBe("/home/jimmy/.ssh/vast_ed25519");
  expect(sshKeyPath("~other/key", HOME)).toBe("~other/key");
});

test("a key file that exists has no problem; a missing one is named", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vastai-key-"));
  const key = join(dir, "vast_ed25519");
  await Bun.write(key, "not a real key");
  expect(await sshKeyProblem(key)).toBeNull();
  const missing = join(dir, "gone");
  expect(await sshKeyProblem(missing, "linux")).toBe(
    `sshKey ${missing} does not exist on this machine: ssh to the boxes will fail until "sshKey" in config.json names the key`,
  );
});

test("a WSL path on native Windows is said to be one", async () => {
  const problem = await sshKeyProblem("/home/nobody-here/.ssh/vast_ed25519", "win32");
  expect(problem).toStartWith(
    "sshKey /home/nobody-here/.ssh/vast_ed25519 is a WSL/Linux path, which does not exist on native Windows",
  );
});
