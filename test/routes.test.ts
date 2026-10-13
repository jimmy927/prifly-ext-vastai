import { describe, expect, test } from "bun:test";
import { type Ran, runOverRoutes, sshRoutes } from "../run";
import { parsePage } from "../vast-api";

const row = {
  id: 7,
  actual_status: "running",
  ssh_host: "ssh9.vast.ai",
  ssh_port: 19928,
  public_ipaddr: "203.0.113.9\n",
  ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "41022" }] },
};
const box = (extra: object = {}) => {
  const found = parsePage({ instances: [{ ...row, ...extra }] }).rows[0];
  if (found === undefined) throw new Error("sample box did not parse");
  return found;
};
const KEY = "/k/key";
const OPTS = ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new"];

describe("sshRoutes", () => {
  test("a box with a 22/tcp mapping offers direct, then the proxy, with the same options", () => {
    expect(sshRoutes(box(), KEY)).toEqual([
      { label: "direct", exec: ["ssh", ...OPTS, "-p", "41022", "root@203.0.113.9"] },
      { label: "proxy", exec: ["ssh", ...OPTS, "-p", "19928", "root@ssh9.vast.ai"] },
    ]);
  });

  test("no 22/tcp mapping, or no public address, offers only the proxy", () => {
    const without = [
      { ports: { "8080/tcp": [{ HostPort: "1" }] } },
      { ports: null },
      { public_ipaddr: undefined },
    ];
    for (const extra of without) {
      expect(sshRoutes(box(extra), KEY).map((r) => r.label)).toEqual(["proxy"]);
    }
  });

  test("a stopped box, or one without an address, has no route", () => {
    expect(sshRoutes(box({ actual_status: "exited" }), KEY)).toEqual([]);
    expect(sshRoutes(box({ ssh_host: undefined }), KEY)).toEqual([]);
  });
});

describe("runOverRoutes", () => {
  const routes = sshRoutes(box(), null);
  const spawner = (codes: number[]) => {
    const argvs: string[][] = [];
    const spawn = async (argv: string[]): Promise<Ran> => {
      argvs.push(argv);
      return { code: codes[argvs.length - 1] ?? 0, out: `out${argvs.length}`, err: "" };
    };
    return { argvs, spawn };
  };

  test("direct failing to connect (255) falls back to the proxy", async () => {
    const { argvs, spawn } = spawner([255, 0]);
    const ran = await runOverRoutes(routes, "uptime", 1000, undefined, spawn);
    expect(ran).toEqual({ code: 0, out: "out2", err: "" });
    expect(argvs.map((a) => a.at(-2))).toEqual(["root@203.0.113.9", "root@ssh9.vast.ai"]);
    expect(argvs[0]?.at(-1)).toBe("uptime");
    expect(argvs[0]).toContain("BatchMode=yes");
  });

  test("direct succeeding does not try the proxy", async () => {
    const { argvs, spawn } = spawner([0]);
    expect((await runOverRoutes(routes, "true", 1000, undefined, spawn)).code).toBe(0);
    expect(argvs).toHaveLength(1);
  });

  test("a failure other than 255 is the answer: no fallback", async () => {
    const { argvs, spawn } = spawner([1]);
    expect((await runOverRoutes(routes, "false", 1000, undefined, spawn)).code).toBe(1);
    expect(argvs).toHaveLength(1);
  });

  test("every route failing to connect answers the last one; no routes answers an error", async () => {
    const { spawn } = spawner([255, 255]);
    expect((await runOverRoutes(routes, "x", 1000, undefined, spawn)).code).toBe(255);
    expect((await runOverRoutes([], "x", 1000, undefined, spawn)).code).toBe(-1);
  });
});
