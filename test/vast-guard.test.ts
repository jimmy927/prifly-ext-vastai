import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { commandOf, deny, refusal } from "../hooks/vast-guard";

const refused = (command: string) => expect(refusal(command)).not.toBeNull();
const passed = (command: string) => expect(refusal(command)).toBeNull();

describe("the vastai CLI", () => {
  test("every writing verb is refused, with the tool to use", () => {
    for (const verb of [
      "create",
      "launch",
      "destroy",
      "label",
      "stop",
      "start",
      "reboot",
      "recycle",
      "update",
      "copy",
      "execute",
    ]) {
      refused(`vastai ${verb} instance 1`);
    }
    expect(refusal("vastai create instance 123 --image ubuntu:22.04")).toContain("vast_rent");
    expect(refusal("vastai destroy instance 123")).toContain("vast_cancel");
    expect(refusal("vastai label instance 1 x")).toContain("vast_rent");
    expect(refusal("vast create instance 1")).toContain("vast_rent");
  });

  test("by path, behind pipes, wrappers and sh -c", () => {
    refused("/home/jimmy/.pyenv/versions/odi-uv1/bin/vastai create instance 1");
    refused("yes y | /path/vastai destroy instance 1");
    refused("cd x && vastai destroy instance 1");
    refused("echo go; nohup vastai create instance 1 &");
    refused('sh -c "vastai destroy instance 1"');
    refused("timeout 30 vastai destroy instance 1");
    refused("env A=b vastai destroy instance 1");
    refused("echo $(vastai create instance 1)");
    refused("uvx vastai destroy instance 1");
    refused("vastai --api-key abc destroy instance 1");
    refused("vastai --raw create instance 1");
  });

  test("reads and unrelated words pass", () => {
    passed("vastai show instances");
    passed("vastai show instances --raw | jq .");
    passed("vastai search offers 'num_gpus=1'");
    passed("vastai logs 123 --tail 400");
    passed("vastai show user");
    passed("vastai set api-key abc");
    passed('grep "vastai create" docs/');
    passed("grep -rn 'vastai destroy' README.md");
    passed("cat vastai-notes.md");
    passed('echo "run vastai create instance later"');
    passed("git commit -m 'vastai create is gone'");
    passed("vastcpu --max-price 0.1");
    passed("ls");
  });

  test("a variable cannot be resolved, so it passes", () => {
    passed("V=/x/vastai; $V destroy instance 1");
  });
});

describe("vastlease", () => {
  test("is refused as a command, not as a word", () => {
    refused("vastlease book lc-box1 3");
    refused("/x/bin/vastlease list");
    refused("echo x; vastlease cancel lc-box1");
    passed("cat vastlease.ts");
    passed("grep vastlease README.md");
  });
});

describe("raw writes to console.vast.ai", () => {
  test("PUT, POST and DELETE are refused", () => {
    refused("curl -X PUT https://console.vast.ai/api/v0/asks/1/");
    refused("curl -XPOST https://console.vast.ai/api/v0/asks/bulk/ -d '{}'");
    refused(
      'curl -s --request DELETE -H "Authorization: Bearer k" https://console.vast.ai/api/v0/instances/1/',
    );
    refused("curl 'https://console.vast.ai/api/v0/asks/1/?a=1&b=2' -X PUT");
    refused("wget --method=DELETE https://console.vast.ai/api/v0/instances/1/");
    refused("http PUT https://console.vast.ai/api/v0/asks/1/");
    refused("echo x | curl -X PUT https://console.vast.ai/api/v0/asks/1/");
    expect(refusal("curl -X PUT https://console.vast.ai/api/v0/asks/1/")).toContain("vast_rent");
  });

  test("reads and other hosts pass", () => {
    passed("curl -sG 'https://console.vast.ai/api/v0/bundles/' --data-urlencode 'q={}'");
    passed("curl https://console.vast.ai/api/v0/instances/");
    passed("curl -X PUT https://example.com/api");
    passed("curl -X POST https://example.com; curl https://console.vast.ai/api/v0/bundles/");
    passed('grep "curl -X PUT console.vast.ai" notes.md');
  });
});

describe("the hook's input and output", () => {
  test("reads the command from the hook JSON", () => {
    expect(commandOf(JSON.stringify({ tool_input: { command: "ls" } }))).toBe("ls");
    expect(commandOf("not json")).toBeNull();
    expect(commandOf(JSON.stringify({ tool_input: { file_path: "x" } }))).toBeNull();
    expect(commandOf(JSON.stringify({}))).toBeNull();
  });

  test("the deny decision has Claude Code's shape", () => {
    expect(deny("why")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "why",
      },
    });
  });

  test("run as the hook: denies on stdout, prints nothing and exits 0 otherwise", async () => {
    const script = join(import.meta.dir, "..", "hooks", "vast-guard.ts");
    const run = async (command: string) => {
      const proc = Bun.spawn(["bun", script], {
        stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { command } })),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      return { code, out };
    };
    const denied = await run("vastai destroy instance 1");
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await run("vastai show instances")).toEqual({ code: 0, out: "" });
  });

  test("the plugin declares the hook where Claude Code looks for it", async () => {
    const hooks = await Bun.file(join(import.meta.dir, "..", "hooks", "hooks.json")).json();
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Bash");
    const command: string = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toStartWith("bun ");
    expect(command).toContain("{CLAUDE_PLUGIN_ROOT}/hooks/vast-guard.ts");
  });
});
