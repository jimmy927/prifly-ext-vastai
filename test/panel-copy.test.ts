import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// @ts-expect-error the panel is plain browser JavaScript, without types
import { copyCommand } from "../panel/machines.js";

const CMD = "ssh -o StrictHostKeyChecking=accept-new -p 22 root@h";
const code = { id: "code" };
const button = () => ({
  textContent: "Copy",
  closest: (selector: string) =>
    selector === ".ssh"
      ? { querySelector: (inner: string) => (inner === "code" ? code : null) }
      : null,
});

const realSetTimeout = globalThis.setTimeout;
let timers: (() => void)[] = [];
beforeEach(() => {
  timers = [];
  globalThis.setTimeout = ((fn: () => void) => {
    timers.push(fn);
    return 0;
  }) as unknown as typeof setTimeout;
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

describe("copying a card's ssh command", () => {
  test("a copy that works says Copied and selects nothing", async () => {
    const written: string[] = [];
    const selected: unknown[] = [];
    const b = button();
    const ok = await copyCommand(b, CMD, {
      clipboard: { writeText: async (t: string) => void written.push(t) },
      select: (c: unknown) => selected.push(c),
      exec: () => {
        throw new Error("execCommand must not run when the async copy worked");
      },
    });
    expect(ok).toBe(true);
    expect(written).toEqual([CMD]);
    expect(b.textContent).toBe("Copied");
    expect(selected).toEqual([]);
    for (const fn of timers) fn();
    expect(b.textContent).toBe("Copy");
  });

  test("a refused async copy falls back to execCommand and says Copied", async () => {
    const calls: string[] = [];
    const selected: unknown[] = [];
    const b = button();
    const ok = await copyCommand(b, CMD, {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
      select: (c: unknown) => {
        calls.push("select");
        selected.push(c);
      },
      exec: (command: string) => {
        calls.push(command);
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(["select", "copy"]);
    expect(selected).toEqual([code]);
    expect(b.textContent).toBe("Copied");
  });

  const failures: [string, unknown][] = [
    ["a rejected write", { writeText: () => Promise.reject(new Error("denied")) }],
    [
      "a write that throws",
      {
        writeText: () => {
          throw new Error("blocked");
        },
      },
    ],
    ["no clipboard at all", undefined],
  ];
  const execFailures: [string, () => boolean][] = [
    ["execCommand returning false", () => false],
    [
      "execCommand throwing",
      () => {
        throw new Error("unsupported");
      },
    ],
  ];
  for (const [name, clipboard] of failures) {
    for (const [execName, exec] of execFailures) {
      test(`${name} and ${execName} says Copy failed and leaves the command selected`, async () => {
        const selected: unknown[] = [];
        const b = button();
        const ok = await copyCommand(b, CMD, {
          clipboard,
          select: (c: unknown) => selected.push(c),
          exec,
        });
        expect(ok).toBe(false);
        expect(b.textContent).toBe("Copy failed");
        expect(selected).toEqual([code]);
        for (const fn of timers) fn();
        expect(b.textContent).toBe("Copy");
      });
    }
  }
});
