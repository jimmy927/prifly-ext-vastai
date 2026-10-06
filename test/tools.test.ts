import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leasesPath, readLeases } from "../leases";
import { SSH_KEY_REPAIR, withSshRepair } from "../rent";
import { ctxFor, H, LABEL, NOW, offer, setup, vast } from "./fake-vast";

/** The onstart of the first create request. */
const sent = (fake: ReturnType<typeof vast>) =>
  String(((fake.puts[0]?.body ?? {}) as { onstart?: string }).onstart);

const RENT = {
  name: "job1",
  budget: 20,
  offers: [101, 102, 103],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "fine-tune a 4B model for about 3 hours",
};

describe("vast_offers", () => {
  test("filters, sorts by price and returns offer ids", async () => {
    const fake = vast([
      offer(1, 0.9),
      offer(2, 0.3, { gpu_name: "RTX 3090", gpu_ram: 24576 }),
      offer(3, 0.5, { reliability: 0.9 }),
      offer(4, 0.4, { gpu_name: "RTX A2000", gpu_ram: 12288 }),
      offer(5, 0.2, { geolocation: "Texas, US" }),
    ]);
    const { tool } = await setup(fake);
    const text = await tool("vast_offers").call(
      { gpu: "rtx", min_vram_gb: 24, region: "SE", max_dph: 1 },
      ctxFor([]).ctx,
    );
    const ids = text
      .split("\n")
      .filter((l) => l.startsWith("offer "))
      .map((l) => l.split(":")[0]);
    // 3 fails the 0.98 reliability floor, 4 the VRAM, 5 the region.
    expect(ids).toEqual(["offer 2", "offer 1"]);
    expect(text).toContain("0.300/h");
  });

  test("min_hours drops offers that end sooner, keeps those with no end date, and the time left is shown", async () => {
    const at = (hours: number) => NOW / 1000 + hours * 3600;
    const fake = vast([
      offer(1, 0.1, { end_date: at(9), duration: 9 * 3600 }),
      offer(2, 0.2, { end_date: at(76), duration: 76 * 3600 }),
      offer(3, 0.3),
    ]);
    const { tool } = await setup(fake);
    const text = await tool("vast_offers").call({ min_hours: 24 }, ctxFor([]).ctx);
    const lines = text.split("\n").filter((l) => l.startsWith("offer "));
    expect(lines.map((l) => l.split(":")[0])).toEqual(["offer 2", "offer 3"]);
    expect(lines[0]).toContain("ends in 3 d 4 h");
    expect(lines[1]).toContain("no end date");
    expect(await tool("vast_offers").call({}, ctxFor([]).ctx)).toContain("ends in 9 h");
  });

  test("says so when nothing passes", async () => {
    const { tool } = await setup(vast([]));
    expect(await tool("vast_offers").call({}, ctxFor([]).ctx)).toContain("No offers pass");
  });

  test("rejects an argument it does not know", async () => {
    const { tool } = await setup(vast([]));
    await expect(tool("vast_offers").call({ gpus: "4090" }, ctxFor([]).ctx)).rejects.toThrow(
      "Bad arguments",
    );
  });
});

describe("vast_rent", () => {
  test("nothing is booked or created before the reader answers, and the card is right", async () => {
    const fake = vast([offer(101, 0.5), offer(102, 0.4)]);
    const { folder, tool } = await setup(fake);
    let putsAtPick = -1;
    let leasesAtPick = -1;
    const { ctx, cards } = ctxFor([{ row: 0, amount: 20 }], () => {
      putsAtPick = fake.puts.length;
      void readLeases(leasesPath(folder)).then((l) => {
        leasesAtPick = l.length;
      });
    });
    await tool("vast_rent").call(RENT, ctx);
    expect(putsAtPick).toBe(0);
    await Bun.sleep(10);
    expect(leasesAtPick).toBe(0);
    const card = cards[0];
    // The full column list is checked in offer-cards.test.ts.
    expect(card?.columns).toHaveLength(18);
    expect(card?.action).toBe("Rent");
    expect(card?.rows.map((r) => r[17])).toEqual(["101", "102"]);
    expect(card?.rows[0]?.[11]).toBe("0.500");
    expect(card?.rows[0]?.[12]).toBe("40.0");
    expect(card?.amount).toEqual({
      label: "Budget for this rental",
      prefix: "$",
      value: 20,
      // An older prifly draws no limit, so the credit is said in the hint.
      hint: "Suggested by Claude: fine-tune a 4B model for about 3 hours. The box is saved and destroyed when it has cost this much. Vast credit $10000.00 − committed $0.00 − margin $909.00 → covers a budget up to $9090.",
      perRow: { column: "Hours", rateColumn: "$/h", unit: "h" },
    });
  });

  test("offers that are gone, or cannot run an hour within the budget, are left off", async () => {
    const fake = vast([offer(101, 0.5), offer(103, 25)]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 20 }]);
    await tool("vast_rent").call(RENT, ctx);
    // 102 is not on the market any more; 103 costs 25 an hour against a budget of 20.
    expect(cards[0]?.rows.map((r) => r[17])).toEqual(["101"]);
  });

  test("when every offer ends too soon it says so and books nothing", async () => {
    const fake = vast([offer(101, 0.5, { end_date: NOW / 1000 + 3600 })]);
    const { folder, tool } = await setup(fake);
    const { ctx, cards } = ctxFor([]);
    await expect(tool("vast_rent").call({ ...RENT, offers: [101] }, ctx)).rejects.toThrow(
      "before the budget runs out",
    );
    expect(cards).toEqual([]);
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("a fallback row that ends too soon for the confirmed budget is skipped", async () => {
    // Budget 1 puts all three on the card (2 to 2.5 h of run); confirming 5 makes 102 run 12.5 h, past its end date.
    const fake = vast(
      [
        offer(101, 0.5, { end_date: NOW / 1000 + 100 * 3600 }),
        offer(102, 0.4, { end_date: NOW / 1000 + 8 * 3600 }),
        offer(103, 0.6, { end_date: NOW / 1000 + 100 * 3600 }),
      ],
      { 101: "gone" },
    );
    const { tool } = await setup(fake);
    const text = await tool("vast_rent").call(
      { ...RENT, budget: 1, offers: [101, 102, 103] },
      ctxFor([{ row: 0, amount: 5 }]).ctx,
    );
    expect(fake.puts.map((p) => p.url.split("/")[6])).toEqual(["101", "103"]);
    expect(text).toContain("#9103");
  });

  test("with no offer left it asks nothing and books nothing", async () => {
    const fake = vast([offer(103, 25)]);
    const { folder, tool } = await setup(fake);
    const { ctx, cards } = ctxFor([]);
    await expect(tool("vast_rent").call(RENT, ctx)).rejects.toThrow("None of the offers");
    expect(cards).toEqual([]);
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("the lease holds the CONFIRMED budget, not the suggested one, and ends where it runs out", async () => {
    const fake = vast([offer(101, 0.5)]);
    const { folder, tool } = await setup(fake);
    const { ctx } = ctxFor([{ row: 0, amount: 7.5 }]);
    const text = await tool("vast_rent").call({ ...RENT, offers: [101] }, ctx);
    const [lease] = await readLeases(leasesPath(folder));
    expect(lease?.budget).toBe(7.5);
    expect(lease?.label).toBe(LABEL);
    // 7.5 / 0.5 = 15 hours.
    expect(lease?.until).toBe(NOW + 15 * H);
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]?.url).toContain("/api/v0/asks/101/");
    expect(fake.puts[0]?.body).toMatchObject({
      label: LABEL,
      cancel_unavail: true,
      image: "ubuntu:22.04",
      disk: 40,
    });
    expect(sent(fake)).toBe(`${SSH_KEY_REPAIR}\nsleep infinity`);
    expect(sent(fake)).not.toMatch(/pkill|HUP/);
    expect(text).toContain("#9101");
    expect(text).toContain(LABEL);
    expect(text).toContain("$0.50/h");
    expect(text).toContain("Budget: $7.50");
  });

  test("a budget that lasts longer than a day gives a lease of 24 hours", async () => {
    const fake = vast([offer(101, 0.5)]);
    const { folder, tool } = await setup(fake);
    await tool("vast_rent").call({ ...RENT, offers: [101] }, ctxFor([{ row: 0, amount: 40 }]).ctx);
    expect((await readLeases(leasesPath(folder)))[0]?.until).toBe(NOW + 24 * H);
  });

  test("ports and env go into the create body the way the CLI sends them", async () => {
    const fake = vast([offer(101, 0.5)]);
    const { tool } = await setup(fake);
    await tool("vast_rent").call(
      { ...RENT, offers: [101], ports: ["8080:8080/tcp"], env: { A: "b" }, onstart: "echo hi" },
      ctxFor([{ row: 0, amount: 5 }]).ctx,
    );
    expect(fake.puts[0]?.body).toMatchObject({
      env: { A: "b", "-p 8080:8080/tcp": "1" },
    });
    const onstart = sent(fake);
    expect(onstart).toBe(`${SSH_KEY_REPAIR}\necho hi`);
    expect(onstart).not.toMatch(/pkill|HUP/);
  });
});

describe("withSshRepair", () => {
  test("the repair comes first and no onstart can make it signal sshd", () => {
    for (const onstart of [undefined, "echo hi", "a\nb"]) {
      const out = withSshRepair(onstart);
      expect(out.startsWith(`${SSH_KEY_REPAIR}\n`)).toBe(true);
      expect(out.endsWith(`\n${onstart ?? "sleep infinity"}`)).toBe(true);
      expect(out).not.toMatch(/pkill|HUP/);
    }
  });

  const bash = Bun.which("bash");
  // The repair uses absolute paths, so the script under test is pointed into a tmp dir.
  const inside = (home: string) =>
    withSshRepair("echo tail-ran")
      .replaceAll("/etc/ssh/", `${home}/etc/ssh/`)
      .replaceAll("/root", `${home}/root`);
  const run = async (script: string) => {
    const proc = Bun.spawn([bash as string, "-e", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return { out, code: await proc.exited };
  };

  test.skipIf(!bash)(
    "the repair cannot stop the caller's onstart, even under bash -e",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "onstart-"));
      try {
        // Nothing exists: every chmod and the sed fail, and the tail still runs.
        const missing = await run(inside(home));
        expect(missing.code).toBe(0);
        expect(missing.out).toContain("tail-ran");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!bash)("the repair fixes the modes and StrictModes it is meant to", async () => {
    const home = await mkdtemp(join(tmpdir(), "onstart-"));
    try {
      await mkdir(join(home, "root/.ssh"), { recursive: true });
      await mkdir(join(home, "etc/ssh"), { recursive: true });
      const keys = join(home, "root/.ssh/authorized_keys");
      const config = join(home, "etc/ssh/sshd_config");
      await writeFile(keys, "ssh-ed25519 AAAA test\n");
      await writeFile(config, "#StrictModes yes\n");
      await chmod(join(home, "root/.ssh"), 0o777);
      await chmod(keys, 0o666);
      const ran = await run(inside(home));
      expect(ran.code).toBe(0);
      expect(ran.out).toContain("tail-ran");
      expect((await stat(keys)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "root/.ssh"))).mode & 0o777).toBe(0o700);
      expect(await readFile(config, "utf8")).toBe("StrictModes no\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("vast_rent card", () => {
  test("an offer that ends before the budget's runtime plus an hour is left off, and the card shows time left", async () => {
    const at = (hours: number) => NOW / 1000 + hours * 3600;
    // Budget 20: 101 and 102 run 24 h (held to the longest lease) and need 25 h of end date.
    const fake = vast([
      offer(101, 0.5, { end_date: at(24.5) }),
      offer(102, 0.4, { end_date: at(30) }),
      offer(103, 0.4, { end_date: at(80) }),
    ]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 20 }]);
    await tool("vast_rent").call(RENT, ctx);
    expect(cards[0]?.rows.map((r) => r[17])).toEqual(["102", "103"]);
    expect(cards[0]?.rows[0]?.[13]).toBe("1 d 6 h");
  });

  test("the card says how much of the machine each offer rents, and the VRAM of all its GPUs", async () => {
    const fake = vast([
      offer(101, 0.5, { num_gpus: 2, gpu_frac: 1, gpu_ram: 97887 }),
      offer(102, 0.5, { num_gpus: 1, gpu_frac: 0.125, gpu_ram: 97887 }),
      offer(103, 0.5),
    ]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 20 }]);
    await tool("vast_rent").call(RENT, ctx);
    expect(cards[0]?.rows.map((r) => [r[0], r[1]])).toEqual([
      ["2x RTX 4090", "2 × 98 GB"],
      ["RTX 4090 · 1 of 8 GPUs", "98 GB"],
      ["RTX 4090", "25 GB"],
    ]);
  });
});

describe("vast_rent backups and failures", () => {
  test("if the chosen offer is gone, the next rows that fit the confirmed budget are tried in card order", async () => {
    // Card order 101, 102, 103, 104; the reader chooses 102 and lowers the budget to 5.
    const fake = vast([offer(101, 0.5), offer(102, 0.4), offer(103, 8), offer(104, 0.6)], {
      102: "gone",
      101: "gone",
    });
    const { folder, tool } = await setup(fake);
    const text = await tool("vast_rent").call(
      { ...RENT, offers: [101, 102, 103, 104] },
      ctxFor([{ row: 1, amount: 5 }]).ctx,
    );
    // 102 (chosen) is gone, then 101 (card order), then 103 costs 8 an hour against 5 and is skipped, and 104 is rented.
    expect(fake.puts.map((p) => p.url.split("/")[6])).toEqual(["102", "101", "104"]);
    expect(text).toContain("#9104");
    const leases = await readLeases(leasesPath(folder));
    expect(leases).toHaveLength(1);
    expect(leases[0]?.budget).toBe(5);
    // The lease ends where this box's budget runs out: 5 / 0.6 hours.
    expect(leases[0]?.until).toBe(NOW + (5 / 0.6) * H);
  });

  test("a chosen offer that costs more than the confirmed budget is not swapped for another", async () => {
    const fake = vast([offer(101, 3), offer(102, 0.4)]);
    const { folder, tool } = await setup(fake);
    await expect(
      tool("vast_rent").call({ ...RENT, offers: [101, 102] }, ctxFor([{ row: 0, amount: 2 }]).ctx),
    ).rejects.toThrow("more than the confirmed budget");
    expect(fake.puts).toEqual([]);
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("choosing none rents nothing and leaves no booking", async () => {
    const fake = vast([offer(101, 0.5)]);
    const { folder, tool } = await setup(fake);
    const text = await tool("vast_rent").call({ ...RENT, offers: [101] }, ctxFor([null]).ctx);
    expect(text).toContain("chose none");
    expect(fake.puts).toEqual([]);
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("when every create fails the booking is dropped and the reasons are said", async () => {
    const fake = vast([offer(101, 0.5), offer(102, 0.4)], { 101: "gone", 102: "error" });
    const { folder, tool } = await setup(fake);
    const failure = await tool("vast_rent")
      .call({ ...RENT, offers: [101, 102] }, ctxFor([{ row: 0, amount: 10 }]).ctx)
      .catch((e: Error) => e);
    expect((failure as Error).message).toContain("No box was rented");
    expect((failure as Error).message).toContain("offer unavailable");
    expect((failure as Error).message).toContain("502");
    expect(fake.puts).toHaveLength(2);
    expect(await readLeases(leasesPath(folder))).toEqual([]);
  });

  test("a box already named so in this session is refused before anything is asked", async () => {
    const fake = vast([offer(101, 0.5)]);
    fake.instances.push({ id: 5, label: LABEL });
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([]);
    await expect(tool("vast_rent").call({ ...RENT, offers: [101] }, ctx)).rejects.toThrow(
      "already has a box named job1",
    );
    expect(cards).toEqual([]);
  });

  test("a name over 8 characters is refused", async () => {
    const { tool } = await setup(vast([]));
    await expect(
      tool("vast_rent").call({ ...RENT, name: "toolongname" }, ctxFor([]).ctx),
    ).rejects.toThrow("Bad arguments");
  });
});
