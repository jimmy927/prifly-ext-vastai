import { describe, expect, test } from "bun:test";
import { claimMap, endpointsPath, readClaims, workerOf } from "../endpoints";
import { boxCards, sessionKeyOf } from "../fleet";
import { show } from "../index";
import { GpuHold } from "../load";
import type { Decoration } from "../prifly-api";
import { ctxFor, NOW, SESSION, setup, vast } from "./fake-vast";

const OTHER = "e5636c90-8276-45ce-8f12-367136e63033";

describe("a serverless worker's label", () => {
  test("names its endpoint, its id and its worker group", () => {
    expect(workerOf("rj-judge:39180:49751")).toEqual({
      endpoint: "rj-judge",
      endpointId: 39180,
      group: 49751,
    });
    expect(workerOf("jimmy/s-0123abcd/job1")).toBeNull();
    expect(workerOf("qwen27b-votes")).toBeNull();
  });
});

describe("vast_claim_endpoint", () => {
  test("claims the endpoint for the calling session, its name from its workers", async () => {
    const fake = vast([]);
    fake.instances.push({ id: 54535465, label: "rj-judge:39180:49751", dph_total: 0.76 });
    const { tool, folder } = await setup(fake);
    const text = await tool("vast_claim_endpoint").call({ endpoint_id: 39180 }, ctxFor([]).ctx);
    expect(text).toBe("Endpoint rj-judge (39180) is this session's. It has 1 worker(s) now.");
    const claims = await readClaims(endpointsPath(folder));
    expect(claims).toEqual([{ endpoint: 39180, name: "rj-judge", session: SESSION, at: NOW }]);
  });

  test("a later session's claim takes the endpoint over", async () => {
    const { tool, folder } = await setup(vast([]));
    const { ctx } = ctxFor([]);
    await tool("vast_claim_endpoint").call(
      { endpoint_id: 38596, name: "rj-reranker" },
      { ...ctx, session: OTHER },
    );
    const text = await tool("vast_claim_endpoint").call({ endpoint_id: 38596 }, ctx);
    expect(text).toContain("It was session e5636c90's until now.");
    expect(claimMap(await readClaims(endpointsPath(folder))).get(38596)).toBe(SESSION);
  });
});

describe("a claimed endpoint's workers", () => {
  const claims = new Map([[39180, OTHER]]);
  const sessions = [{ id: OTHER, title: "OSS 120B inference", cwd: "/src/odi", state: "idle" }];
  const worker = {
    id: 54535465,
    label: "rj-judge:39180:49751",
    actual_status: "running",
    dph_total: 0.76,
  };

  test("show on the session that claimed it, named by the endpoint", () => {
    expect(sessionKeyOf(worker, "jimmy", claims)).toBe(OTHER);
    const [card] = boxCards([worker], {
      owner: "jimmy",
      enforce: false,
      sshKey: null,
      sessions,
      judged: new Map(),
      hold: new GpuHold(),
      now: NOW,
      claims,
    });
    expect(card).toMatchObject({
      name: "rj-judge",
      owner: { kind: "serverless" },
      serverless: { endpoint: "rj-judge", endpointId: 39180, group: 49751 },
      session: { short: "e5636c90", id: OTHER, title: "OSS 120B inference" },
    });
    const shown: Record<string, Decoration[]> = {};
    show(
      { sessions: () => sessions, show: (by) => Object.assign(shown, by) },
      [worker, { ...worker, id: 2, label: "rj-reranker:38596:49000" }],
      new Map(),
      { owner: "jimmy", enforce: false, sshKey: null },
      new GpuHold(),
      NOW,
      claims,
    );
    expect(Object.keys(shown)).toEqual([OTHER]);
    expect(shown[OTHER]?.map((d) => d.key)).toEqual(["54535465"]);
  });
});
