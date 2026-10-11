import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boxRunner,
  type onBox,
  run,
  sshKeyPath,
  sshKeyProblem,
  VAULT_SSH_ENTRY,
  withStdin,
} from "../run";
import { fakeVault } from "./fake-state";

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

describe("ssh with the key in prifly's vault", () => {
  const target = { host: "ssh1.vast.ai", port: 20001 };
  const done = { ok: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" } as const;
  /** The plain path, written down instead of run: no ssh leaves this test. */
  function plainCalls() {
    const calls: { sshKey: string | null; command: string; stdin: string | undefined }[] = [];
    const plain: typeof onBox = async (_to, sshKey, command, _ms, stdin) => {
      calls.push({ sshKey, command, stdin });
      return { code: 0, out: "plain", err: "" };
    };
    return { calls, plain };
  }

  test('without "vault-ssh" the configured key is used, as before', async () => {
    const { vault, calls } = fakeVault(done);
    const plain = plainCalls();
    const runner = boxRunner({ features: ["state"], vault, log: () => undefined }, plain.plain);
    expect(runner).toBe(plain.plain);
    expect(boxRunner({ vault, log: () => undefined }, plain.plain)).toBe(plain.plain);
    await runner(target, "/k", "true", 1000);
    expect(calls).toEqual([]);
    expect(plain.calls).toEqual([{ sshKey: "/k", command: "true", stdin: undefined }]);
  });

  test("with it, prifly runs ssh with the vast-ssh entry, and no -i of ours", async () => {
    const { vault, calls } = fakeVault({ ...done, exitCode: 3, stdout: "out", stderr: "err" });
    const plain = plainCalls();
    const runner = boxRunner({ features: ["vault-ssh"], vault, log: () => undefined }, plain.plain);
    expect(await runner(target, "/k", "true", 900_000)).toEqual({
      code: 3,
      out: "out",
      err: "err",
    });
    expect(plain.calls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(VAULT_SSH_ENTRY);
    expect(calls[0]?.argv).not.toContain("-i");
    expect(calls[0]?.argv).not.toContain("/k");
    expect(calls[0]?.argv[0]).toBe("ssh");
    expect(calls[0]?.argv.slice(-3)).toEqual(["20001", "root@ssh1.vast.ai", "true"]);
    // prifly runs a vault ssh for 10 minutes at most.
    expect(calls[0]?.options).toEqual({ timeoutMs: 600_000 });
  });

  test("stdin goes in the command, since a vault ssh takes none", async () => {
    const { vault, calls } = fakeVault(done);
    const runner = boxRunner({ features: ["vault-ssh"], vault, log: () => undefined });
    const script = "#!/bin/sh\necho 'hi' $HOME\n";
    await runner(target, null, "cat > /root/x; echo done", 1000, script);
    expect(calls[0]?.argv.at(-1)).toBe(withStdin("cat > /root/x; echo done", script));
  });

  test.skipIf(process.platform === "win32")(
    "the box's shell gets that stdin back whole",
    async () => {
      const script = "#!/bin/sh\necho 'it''s' \"$HOME\" `x`\n";
      const ran = await run(["sh", "-c", withStdin("cat; echo done", script)], 5000);
      expect(ran).toEqual({ code: 0, out: `${script}done\n`, err: "" });
    },
  );

  test("a vault that says no: logged once, then the configured key, as before", async () => {
    const { vault } = fakeVault({ ok: false, message: "no ssh-key entry vast-ssh" });
    const logged: unknown[] = [];
    const plain = plainCalls();
    const runner = boxRunner(
      { features: ["vault-ssh"], vault, log: (event, fields) => logged.push({ event, fields }) },
      plain.plain,
    );
    expect(await runner(target, "/k", "true", 1000, "in")).toEqual({
      code: 0,
      out: "plain",
      err: "",
    });
    await runner(target, "/k", "true", 1000);
    expect(plain.calls).toEqual([
      { sshKey: "/k", command: "true", stdin: "in" },
      { sshKey: "/k", command: "true", stdin: undefined },
    ]);
    expect(logged).toEqual([
      {
        event: "vault_ssh_refused",
        fields: { entry: "vast-ssh", message: "no ssh-key entry vast-ssh", fallback: "/k" },
      },
    ]);
  });
});
