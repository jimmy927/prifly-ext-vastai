import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  compact,
  cpuLink,
  cpuPerf,
  cpuScores,
  indexChips,
  modelKey,
  parseChips,
  resetCpuScores,
  shortCpuName,
} from "../cpu-score";
import { gpuLink } from "../gpu-link";
import { ctxFor, NOW, offer, setup, vast } from "./fake-vast";

const FIXTURE = await readFile(new URL("./passmark-cpus.txt", import.meta.url), "utf8");
const INDEX = indexChips(parseChips(FIXTURE));

beforeEach(resetCpuScores);
afterEach(resetCpuScores);

describe("cpu-score", () => {
  test("parses name, CPU Mark and the absolute link of each chip", () => {
    const chips = parseChips(FIXTURE);
    expect(chips).toHaveLength(5);
    expect(chips.find((c) => c.name === "Intel Xeon Gold 6430")).toEqual({
      name: "Intel Xeon Gold 6430",
      mark: 53_587,
      url: expect.stringMatching(/^https:\/\/www\.cpubenchmark\.net\/cpu\.php\?cpu=.+&id=\d+$/),
    });
    expect(chips.find((c) => c.name === "AMD EPYC 7742")?.mark).toBe(69_583);
  });

  test("Vast's names match PassMark's by model tokens", () => {
    expect(modelKey("Xeon® Gold 6430")).toBe(modelKey("Intel Xeon Gold 6430"));
    expect(modelKey("AMD EPYC 7742 64-Core Processor")).toBe(modelKey("AMD EPYC 7742"));
    expect(modelKey("Intel Xeon Platinum 8470 @2.00GHz")).toBe("xeon platinum 8470");
    expect(cpuLink({ cpu_name: "Xeon® Gold 6430" }, INDEX)).toContain("cpu.php?cpu=");
    expect(cpuLink({ cpu_name: "AMD EPYC 7742 64-Core Processor" }, INDEX)).toContain("id=");
  });

  test("scales the chip's mark by the threads rented over the chip's threads", () => {
    // 53587 / 64 threads * 128 rented.
    expect(cpuPerf({ cpu_name: "Xeon® Gold 6430", cpu_cores_effective: 128 }, INDEX)).toBeCloseTo(
      107_174,
      0,
    );
    // 69583 / 128 threads * 256 rented.
    expect(
      cpuPerf({ cpu_name: "AMD EPYC 7742 64-Core Processor", cpu_cores_effective: 256 }, INDEX),
    ).toBeCloseTo(139_166, 0);
  });

  test("a chip off PassMark's page, off the thread table, or an offer with no CPU is unscored, never core count", () => {
    expect(
      cpuPerf({ cpu_name: "XEON® PLATINUM 8563C", cpu_cores_effective: 208 }, INDEX),
    ).toBeNull();
    // On the page, but with no known thread count: an unscored chip.
    const odd = indexChips(
      parseChips(
        '<a href="/cpu.php?cpu=AMD+EPYC+9K84&amp;id=1"><span class="prdname">AMD EPYC 9K84</span><span class="count">123,456</span>',
      ),
    );
    expect(cpuPerf({ cpu_name: "AMD EPYC 9K84", cpu_cores_effective: 16 }, odd)).toBeNull();
    expect(cpuPerf({ cpu_cores_effective: 16 }, INDEX)).toBeNull();
    expect(cpuLink({ cpu_name: "XEON® PLATINUM 8563C" }, INDEX)).toBeNull();
  });

  test("short names and compact scores", () => {
    expect(shortCpuName("XEON® PLATINUM 8563C")).toBe("Xeon Plat. 8563C");
    expect(shortCpuName("AMD EPYC 7742 64-Core Processor")).toBe("EPYC 7742");
    expect(shortCpuName("Intel(R) Xeon(R) Gold 6430 CPU @ 2.10GHz")).toBe("Xeon Gold 6430");
    expect([compact(139_166), compact(12_886), compact(950), compact(10_812)]).toEqual([
      "139k",
      "12.9k",
      "950",
      "10.8k",
    ]);
  });

  test("the page is fetched once a day with a browser User-Agent, and a failure leaves every chip unscored", async () => {
    const fake = vast([]);
    fake.cpuPage.html = FIXTURE;
    expect((await cpuScores(fake.get, NOW)).size).toBe(5);
    await cpuScores(fake.get, NOW + 23 * 3_600_000);
    expect(fake.cpuPage.fetches).toHaveLength(1);
    expect(fake.cpuPage.fetches[0]).toContain("Chrome/128");
    await cpuScores(fake.get, NOW + 25 * 3_600_000);
    expect(fake.cpuPage.fetches).toHaveLength(2);

    resetCpuScores();
    const blocked = vast([]);
    expect((await cpuScores(blocked.get, NOW)).size).toBe(0);
  });
});

describe("gpu-link", () => {
  test("links the known names and leaves the rest", () => {
    expect(gpuLink("RTX PRO 6000 S")).toBe(
      "https://www.videocardbenchmark.net/gpu.php?gpu=RTX+PRO+6000+Blackwell+Server+Edition&id=6962",
    );
    expect(gpuLink("RTX PRO 6000 WS")).toContain("Workstation+Edition&id=6307");
    expect(gpuLink("RTX 4090")).toContain("id=4606");
    expect(gpuLink("H100 SXM")).toBeNull();
    expect(gpuLink(undefined)).toBeNull();
  });
});

const BIG = {
  gpu_name: "RTX PRO 6000 S",
  num_gpus: 8,
  gpu_ram: 97_887,
  dlperf: 1330.749,
  gpu_mem_bw: 1397.8,
  cpu_name: "XEON® PLATINUM 8563C",
  cpu_cores_effective: 208,
  cpu_ram: 1_031_712,
  disk_space: 2872,
  inet_down: 1881.3,
  verification: "deverified",
  geolocation: "California, US",
  end_date: NOW / 1000 + 30 * 86_400,
};
const WS = {
  ...BIG,
  gpu_name: "RTX PRO 6000 WS",
  dlperf: 680,
  cpu_name: "AMD EPYC 7742 64-Core Processor",
  cpu_cores_effective: 256,
  verification: "verified",
};
const RENT = {
  name: "job1",
  budget: 20,
  offers: [1, 2, 3],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "rank by performance",
};

function world(features: string[] = []) {
  const fake = vast([
    offer(1, 9.822, BIG),
    offer(2, 10.8, WS),
    offer(3, 4, {
      gpu_name: "RTX 4090",
      num_gpus: 2,
      gpu_frac: 0.5,
      dlperf: 80,
      cpu_name: "Xeon® Gold 6430",
      cpu_cores_effective: 128,
    }),
  ]);
  fake.cpuPage.html = FIXTURE;
  return { fake, ready: setup(fake, features) };
}

describe("the rent card", () => {
  test("shows GPU and CPU performance, each per $/h, and never links on a prifly without pick-links", async () => {
    const { ready } = world();
    const { tool } = await ready;
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    const card = cards[0];
    expect(card?.columns).toEqual([
      "GPU",
      "VRAM",
      "GPU perf",
      "GPU perf / $/h",
      "Mem GB/s",
      "CPU",
      "CPU perf",
      "CPU perf / $/h",
      "RAM",
      "Disk",
      "Down Mbps",
      "$/h",
      "Hours",
      "Ends in",
      "Reliability",
      "Verified",
      "Location",
      "Offer",
    ]);
    expect(card?.rows[0]).toEqual([
      "8x RTX PRO 6000 S",
      "8 × 98 GB",
      "1331",
      "135",
      "1398",
      "208 × Xeon Plat. 8563C",
      "unscored",
      "–",
      "1032 GB",
      "2872 GB",
      "1881",
      "9.822",
      (20 / 9.822).toFixed(1),
      "30 d 0 h",
      "0.990",
      "lost",
      "California, US",
      "1",
    ]);
    expect(card?.rows[1]?.slice(0, 8)).toEqual([
      "8x RTX PRO 6000 WS",
      "8 × 98 GB",
      "680",
      "63",
      "1398",
      "256 × EPYC 7742",
      "139k",
      "12.9k",
    ]);
    expect(card?.rows[1]?.[15]).toBe("yes");
    // A part of a machine says so in the GPU cell; 53587 / 64 * 128 = 107k, per $4/h 26.8k.
    expect(card?.rows[2]?.[0]).toBe("2x RTX 4090 · 2 of 4 GPUs");
    expect(card?.rows[2]?.slice(5, 8)).toEqual(["128 × Xeon Gold 6430", "107k", "26.8k"]);
    expect(card?.columns[12]).toBe("Hours");
    expect(card?.amount?.perRow).toEqual({ column: "Hours", rateColumn: "$/h", unit: "h" });
    expect(card).not.toHaveProperty("links");
  });

  test("with pick-links the GPU and CPU cells link to PassMark, null where unscored or unmapped", async () => {
    const { ready } = world(["pick-links"]);
    const { tool } = await ready;
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    const links = cards[0]?.links;
    expect(links).toHaveLength(3);
    for (const row of links ?? []) expect(row).toHaveLength(18);
    expect(links?.[0]?.[0]).toContain("Server+Edition&id=6962");
    expect(links?.[0]?.[5]).toBeNull();
    expect(links?.[1]?.[5]).toMatch(
      /^https:\/\/www\.cpubenchmark\.net\/cpu\.php\?cpu=AMD\+EPYC\+7742&id=\d+$/,
    );
    expect(links?.[2]?.[0]).toContain("id=4606");
    expect(links?.[2]?.[5]).toContain("Gold+6430");
    const others = links?.flatMap((row) => row.filter((_, i) => i !== 0 && i !== 5));
    expect(others?.every((link) => link === null)).toBe(true);
  });

  test("a PassMark page that cannot be read leaves the CPUs unscored and the rent working", async () => {
    const { fake, ready } = world();
    fake.cpuPage.html = null;
    const { tool } = await ready;
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    expect(cards[0]?.rows.map((row) => row.slice(6, 8))).toEqual([
      ["unscored", "–"],
      ["unscored", "–"],
      ["unscored", "–"],
    ]);
  });

  test("an offer Vast gives no scores for shows a question mark, and verification maps", async () => {
    const fake = vast([offer(1, 1)]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call({ ...RENT, offers: [1] }, ctx);
    const row = cards[0]?.rows[0];
    expect(row?.slice(2, 5)).toEqual(["?", "–", "?"]);
    expect(row?.[15]).toBe("?");
  });
});

describe("vast_offers text", () => {
  test("ranks by GPU and CPU performance, memory bandwidth and verification", async () => {
    const { ready } = world();
    const { tool } = await ready;
    const text = await tool("vast_offers").call({}, ctxFor([]).ctx);
    expect(text).toContain(
      "GPU perf 680 (63 per $/h) · 1398 GB/s memory · 256 × EPYC 7742 · CPU perf 139k (12.9k per $/h)",
    );
    expect(text).toContain("CPU perf unscored (– per $/h)");
    expect(text).toContain("verified lost");
    expect(text).toContain("verified yes");
  });
});
