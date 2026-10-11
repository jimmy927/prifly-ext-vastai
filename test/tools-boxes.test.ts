import { describe, expect, test } from "bun:test";
import { type Lease, readLeases, updateLeases } from "../leases";
import { fileStore } from "../store";
import { ctxFor, H, LABEL, NOW, setup, vast } from "./fake-vast";

/**
 * This session's box: 2 an hour, started an hour ago, with a lease to an hour
 * from now; its host's end date `hostEndsIn` ms from now, when given.
 */
async function withBox(budget: number | null, hostEndsIn?: number) {
  const fake = vast([]);
  fake.instances.push(
    {
      id: 7,
      label: LABEL,
      dph_total: 2,
      start_date: (NOW - H) / 1000,
      actual_status: "running",
      ssh_host: "ssh1.vast.ai",
      ssh_port: 20001,
      ...(hostEndsIn === undefined ? {} : { end_date: (NOW + hostEndsIn) / 1000 }),
    },
    { id: 8, label: "jimmy/s-99999999/other", dph_total: 1, start_date: NOW / 1000 },
    { id: 9, label: "anna/s-0123abcd/theirs", dph_total: 1, start_date: NOW / 1000 },
    { id: 10, label: null },
  );
  const ctx = await setup(fake);
  const lease: Lease = {
    label: LABEL,
    box: 7,
    bookedAt: NOW - H,
    until: NOW + H,
    cancelled: false,
    budget,
  };
  await updateLeases(fileStore(ctx.folder), () => ({ leases: [lease], result: null }));
  return { fake, ...ctx };
}

const only = async (folder: string) => (await readLeases(fileStore(folder)))[0];

describe("vast_boxes", () => {
  test("lists this session's boxes only, with spend of budget, lease end and ssh", async () => {
    const { tool } = await withBox(10);
    const text = await tool("vast_boxes").call({}, ctxFor([]).ctx);
    expect(text.split("\n")).toHaveLength(2);
    expect(text.split("\n")[0]).toMatch(
      /^Account: credit \$10000\.00 · burn \$2\.00\/h · runway 5000h 0m · committed \$8\.00$/,
    );
    expect(text).toContain("job1 (#7): running");
    expect(text).toContain("$2.00/h");
    expect(text).toContain("$2.00 of $10");
    expect(text).toContain("lease until");
    expect(text).toContain("-p 20001 root@ssh1.vast.ai");
    expect(text).not.toContain("other");
    expect(text).not.toContain("theirs");
  });

  test("shows the host's end date and the time left, when the box has one", async () => {
    const { tool } = await withBox(10, 3 * H);
    expect(await tool("vast_boxes").call({}, ctxFor([]).ctx)).toMatch(
      /host end date .*\(3h 0m left\)/,
    );
  });

  test("a box with no host end date says nothing of one", async () => {
    const { tool } = await withBox(10);
    expect(await tool("vast_boxes").call({}, ctxFor([]).ctx)).not.toContain("host end date");
  });

  test("a box without a budget says so", async () => {
    const { tool } = await withBox(null);
    expect(await tool("vast_boxes").call({}, ctxFor([]).ctx)).toContain("$2.00 spent, no budget");
  });
});

describe("vast_logs", () => {
  test("returns the tail of this session's box's logs", async () => {
    const { tool } = await withBox(10);
    expect(await tool("vast_logs").call({ name: "job1", tail: 2 }, ctxFor([]).ctx)).toBe("c\nd");
  });

  test("another session's box is not reachable", async () => {
    const { tool } = await withBox(10);
    await expect(tool("vast_logs").call({ name: "other" }, ctxFor([]).ctx)).rejects.toThrow(
      "has no box other",
    );
    await expect(tool("vast_logs").call({ name: "8" }, ctxFor([]).ctx)).rejects.toThrow(
      "has no box 8",
    );
  });
});

describe("vast_extend", () => {
  test("within the budget it is free: no card, the lease moves", async () => {
    const { tool, folder } = await withBox(10);
    const { ctx, cards } = ctxFor([]);
    // Two hours more: the box would have cost 8 of 10 by then.
    const text = await tool("vast_extend").call({ name: "job1", hours: 2 }, ctx);
    expect(cards).toEqual([]);
    expect((await only(folder))?.until).toBe(NOW + 3 * H);
    expect(text).toContain("lease now runs until");
    expect(text).toContain("budget $10");
  });

  test("over the budget it asks on a one-row card, and raises to what the reader confirms", async () => {
    const { tool, folder } = await withBox(10);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 15 }]);
    // Four hours more would cost 12 in all.
    await tool("vast_extend").call({ name: "job1", hours: 4 }, ctx);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.rows).toHaveLength(1);
    expect(cards[0]?.action).toBe("Raise budget");
    expect(cards[0]?.amount?.label).toBe("New budget for job1");
    expect(cards[0]?.amount?.prefix).toBe("$");
    expect(cards[0]?.amount?.value).toBe(12);
    expect(cards[0]?.amount?.hint).toStartWith("Suggested by Claude:");
    const lease = await only(folder);
    expect(lease?.budget).toBe(15);
    expect(lease?.until).toBe(NOW + 5 * H);
  });

  test("it extends only as far as the confirmed budget allows", async () => {
    const { tool, folder } = await withBox(10);
    // 11 dollars last 5.5 hours from the start, an hour ago: until 4.5 hours from now.
    const text = await tool("vast_extend").call(
      { name: "job1", hours: 4 },
      ctxFor([{ row: 0, amount: 11 }]).ctx,
    );
    const lease = await only(folder);
    expect(lease?.budget).toBe(11);
    expect(lease?.until).toBe(NOW + 4.5 * H);
    expect(text).toContain("fit the budget");
  });

  test("if the reader raises nothing, nothing changes", async () => {
    const { tool, folder } = await withBox(10);
    const text = await tool("vast_extend").call({ name: "job1", hours: 4 }, ctxFor([null]).ctx);
    const lease = await only(folder);
    expect(lease?.budget).toBe(10);
    expect(lease?.until).toBe(NOW + H);
    expect(text).toContain("did not raise the budget");
  });

  test("a confirmed budget below what is already spent changes nothing", async () => {
    const { tool, folder } = await withBox(10);
    const text = await tool("vast_extend").call(
      { name: "job1", hours: 4 },
      ctxFor([{ row: 0, amount: 1 }]).ctx,
    );
    expect((await only(folder))?.budget).toBe(10);
    expect(text).toContain("nothing was changed");
  });

  test("a box with no budget extends freely", async () => {
    const { tool, folder } = await withBox(null);
    const { ctx, cards } = ctxFor([]);
    await tool("vast_extend").call({ name: "job1", hours: 4 }, ctx);
    expect(cards).toEqual([]);
    expect((await only(folder))?.until).toBe(NOW + 5 * H);
  });

  test("it never reaches past 30 minutes before the host's end date, and says so", async () => {
    // The lease ends in 1 h, the host stops the box in 3 h: 2.5 h from now is the most.
    const { tool, folder } = await withBox(null, 3 * H);
    const text = await tool("vast_extend").call({ name: "job1", hours: 4 }, ctxFor([]).ctx);
    expect((await only(folder))?.until).toBe(NOW + 2.5 * H);
    expect(text).toContain("host's end date limits it");
    expect(text).toContain("(3h 0m left)");
    expect(text).toContain("Only 1h 30m of the 4 hours fit");
  });

  test("a lease already at the host's limit is unchanged, and the reader is not asked for money", async () => {
    // The lease ends in 1 h; the host stops the box in 1 h 30 m, so the limit is in 1 h: no room.
    const { tool, folder } = await withBox(null, H + 30 * 60_000);
    const { ctx, cards } = ctxFor([]);
    const text = await tool("vast_extend").call({ name: "job1", hours: 5 }, ctx);
    expect(cards).toEqual([]);
    expect((await only(folder))?.until).toBe(NOW + H);
    expect(text).toContain("lease is unchanged");
    expect(text).toContain("host's end date limits it");
  });

  test("a host end date far away limits nothing", async () => {
    const { tool, folder } = await withBox(null, 40 * H);
    const text = await tool("vast_extend").call({ name: "job1", hours: 2 }, ctxFor([]).ctx);
    expect((await only(folder))?.until).toBe(NOW + 3 * H);
    expect(text).not.toContain("host's end date");
  });

  test("another session's box cannot be extended", async () => {
    const { tool } = await withBox(10);
    await expect(
      tool("vast_extend").call({ name: "other", hours: 1 }, ctxFor([]).ctx),
    ).rejects.toThrow("has no box other");
  });
});

describe("vast_cancel", () => {
  test("cancels this session's lease: the enforcer destroys the box", async () => {
    const { tool, folder } = await withBox(10);
    const text = await tool("vast_cancel").call({ name: "job1" }, ctxFor([]).ctx);
    expect((await only(folder))?.cancelled).toBe(true);
    expect(text).toContain("saved and destroyed within a minute");
  });

  test("by Vast.ai id, and not for another session's box", async () => {
    const { tool, folder } = await withBox(10);
    await tool("vast_cancel").call({ name: "7" }, ctxFor([]).ctx);
    expect((await only(folder))?.cancelled).toBe(true);
    await expect(tool("vast_cancel").call({ name: "other" }, ctxFor([]).ctx)).rejects.toThrow(
      "no lease for other",
    );
  });

  test("a booking nothing was rented for is dropped", async () => {
    const { tool, folder } = await withBox(10);
    await updateLeases(fileStore(folder), () => ({
      leases: [
        {
          label: "jimmy/s-0123abcd/wait",
          box: null,
          bookedAt: NOW,
          until: NOW + H,
          cancelled: false,
          budget: 3,
        },
      ],
      result: null,
    }));
    const text = await tool("vast_cancel").call({ name: "wait" }, ctxFor([]).ctx);
    expect(text).toContain("Dropped the booking");
    expect(await readLeases(fileStore(folder))).toEqual([]);
  });
});
