import { describe, expect, test } from "bun:test";
import { type Lease, leasesPath, readLeases, updateLeases } from "../leases";
import { ctxFor, H, LABEL, NOW, offer, setup, vast } from "./fake-vast";

const LIMIT = ["pick-amount-limit"];

const RENT = {
  name: "job1",
  budget: 60,
  offers: [101],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "train for about 50 hours",
};

/** A Vast.ai with $100 of credit and another session's box using $40 of it. */
function lowCredit() {
  const fake = vast([offer(101, 0.5)]);
  if (fake.account.user !== null) fake.account.user["credit"] = 100;
  fake.instances.push({
    id: 50,
    label: "jimmy/s-99999999/other",
    actual_status: "running",
    dph_total: 1,
    start_date: (NOW - 10 * H) / 1000,
  });
  return fake;
}

async function withOtherLease(folder: string) {
  const other: Lease = {
    label: "jimmy/s-99999999/other",
    box: 50,
    bookedAt: NOW - 10 * H,
    until: NOW + 10 * H,
    cancelled: false,
    budget: 50,
  };
  await updateLeases(leasesPath(folder), () => ({ leases: [other], result: null }));
}

describe("vast_rent and the account's credit", () => {
  test("the card carries the limit: credit, what is committed, and the most it covers", async () => {
    const fake = lowCredit();
    const { tool, folder } = await setup(fake, LIMIT);
    await withOtherLease(folder);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    const amount = cards[0]?.amount;
    // 100 − 40 committed = 60 free: 54.5 by the share, 60 − 3 × 1.5 = 55.5 by the hours.
    expect(amount?.limit?.max).toBe(54);
    expect(amount?.limit?.text).toBe(
      "Vast credit $100.00 − committed $40.00 (other: $40.00 left of its budget) − margin $9.40 → covers a budget up to $54.",
    );
    expect(amount?.limit?.over).toContain("other included");
    expect(amount?.limit?.ack).toBe("Rent anyway: I will top up before the credit runs out");
    expect(amount?.hint).not.toContain("Vast credit");
  });

  test("past the limit, after the reader's tick, it rents and says when to top up", async () => {
    const fake = lowCredit();
    const { tool, folder } = await setup(fake, LIMIT);
    await withOtherLease(folder);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 60 }]);
    const text = await tool("vast_rent").call(RENT, ctx);
    expect(cards).toHaveLength(1);
    expect(fake.puts).toHaveLength(1);
    expect(text).toContain("The budget is $6.00 more than the Vast credit covers ($54)");
    expect(text).toContain("console.vast.ai → Billing");
  });

  test("within the limit, nothing more is said", async () => {
    const fake = lowCredit();
    const { tool, folder } = await setup(fake, LIMIT);
    await withOtherLease(folder);
    const text = await tool("vast_rent").call(RENT, ctxFor([{ row: 0, amount: 50 }]).ctx);
    expect(text).not.toContain("credit");
  });

  test("an older prifly: the credit is in the hint, and past it a second card asks", async () => {
    const fake = lowCredit();
    const { tool, folder } = await setup(fake);
    await withOtherLease(folder);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 60 }, null]);
    const text = await tool("vast_rent").call(RENT, ctx);
    expect(cards[0]?.amount?.limit).toBeUndefined();
    expect(cards[0]?.amount?.hint).toContain("covers a budget up to $54");
    expect(cards[1]?.action).toBe("Rent anyway: I will top up before the credit runs out");
    expect(cards[1]?.rows).toEqual([["$60", "$54", "$6.00"]]);
    expect(text).toContain("Nothing was rented");
    expect(fake.puts).toHaveLength(0);
    expect((await readLeases(leasesPath(folder))).map((l) => l.label)).toEqual([
      "jimmy/s-99999999/other",
    ]);
  });

  test("when Vast.ai does not say the credit, the card says so and nothing is held back", async () => {
    const fake = lowCredit();
    fake.account.user = null;
    const { tool } = await setup(fake, LIMIT);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 60 }]);
    const text = await tool("vast_rent").call(RENT, ctx);
    expect(cards[0]?.amount?.limit).toBeUndefined();
    expect(cards[0]?.amount?.hint).toContain("Vast credit unknown");
    expect(text).toContain("Rented job1");
  });
});

describe("vast_extend and the account's credit", () => {
  test("the raise card's limit counts what the box has spent and the credit left after the rest", async () => {
    const fake = vast([]);
    if (fake.account.user !== null) fake.account.user["credit"] = 20;
    fake.instances.push({
      id: 7,
      label: LABEL,
      dph_total: 2,
      start_date: (NOW - H) / 1000,
      actual_status: "running",
    });
    const { tool, folder } = await setup(fake, LIMIT);
    const lease: Lease = {
      label: LABEL,
      box: 7,
      bookedAt: NOW - H,
      until: NOW + H,
      cancelled: false,
      budget: 10,
    };
    await updateLeases(leasesPath(folder), () => ({ leases: [lease], result: null }));
    const { ctx, cards } = ctxFor([{ row: 0, amount: 30 }]);
    await tool("vast_extend").call({ name: "job1", hours: 10 }, ctx);
    // $2 spent; $20 free: 18.18 by the share, 20 − 3 × 2 = 14 by the hours.
    expect(cards[0]?.amount?.limit?.max).toBe(16);
    expect(cards[0]?.amount?.limit?.text).toContain(
      "covers a budget up to $16 ($2.00 of it spent already)",
    );
    expect(cards[0]?.amount?.limit?.ack).toBe(
      "Raise anyway: I will top up before the credit runs out",
    );
    expect((await readLeases(leasesPath(folder)))[0]?.budget).toBe(30);
  });
});
