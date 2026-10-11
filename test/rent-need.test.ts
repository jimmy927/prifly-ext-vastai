import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resetCpuScores } from "../cpu-score";
import { ctxFor, NOW, offer, setup, vast } from "./fake-vast";

const FIXTURE = await readFile(new URL("./passmark-cpus.txt", import.meta.url), "utf8");

beforeEach(resetCpuScores);
afterEach(resetCpuScores);

const COLUMNS = [
  "GPU",
  "VRAM",
  "GPU perf · /$",
  "Mem GB/s",
  "CPU",
  "CPU perf · /$",
  "RAM",
  "Disk",
  "Mbps",
  "$/h",
  "Hours",
  "Ends in",
  "Rel.",
  "Verified",
  "Where",
  "Offer",
];
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
const RENT = {
  name: "job1",
  budget: 20,
  offers: [1, 2, 3],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "call Gemini about 40 times",
  need: "gpu" as const,
  need_note: "one GPU for the job",
};

function world(features: string[] = []) {
  const fake = vast([
    offer(1, 9.822, BIG),
    offer(2, 10.8, {
      ...BIG,
      cpu_name: "AMD EPYC 7742 64-Core Processor",
      cpu_cores_effective: 256,
    }),
    offer(3, 4, { ...BIG, cpu_name: "Xeon® Gold 6430", cpu_cores_effective: 128 }),
  ]);
  fake.cpuPage.html = FIXTURE;
  return setup(fake, features);
}

describe("the rent card by need", () => {
  const GPU_COLUMNS = ["GPU", "VRAM", "GPU perf · /$", "Mem GB/s"];
  const shown = async (need: "gpu" | "cpu" | "io", features: string[] = []) => {
    const { tool } = await world(features);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call({ ...RENT, need, need_note: "1-2 threads: waits on Gemini" }, ctx);
    const card = cards[0];
    if (card === undefined) throw new Error("no card");
    return card;
  };

  test("an io card has no GPU, VRAM, GPU perf, Mem or CPU perf column, and every grid matches its columns", async () => {
    const card = await shown("io", ["pick-links", "pick-cells"]);
    for (const gone of [...GPU_COLUMNS, "CPU perf · /$"]) expect(card.columns).not.toContain(gone);
    expect(card.columns).toEqual([
      "CPU",
      "RAM",
      "Disk",
      "Mbps",
      "$/h",
      "Hours",
      "Ends in",
      "Rel.",
      "Verified",
      "Where",
      "Offer",
    ]);
    for (const grid of [card.rows, card.links, card.titles, card.cellKinds]) {
      expect(grid).toHaveLength(3);
      for (const row of grid ?? []) expect(row).toHaveLength(card.columns.length);
    }
    const at = (name: string) => card.columns.indexOf(name);
    expect(card.links?.[1]?.[at("CPU")]).toContain("EPYC");
    expect(card.links?.[0]?.[at("Offer")]).toContain("?ask=1");
    expect(card.cellKinds?.[0]?.[at("Offer")]).toBe("link-icon");
    expect(card.cellKinds?.[0]?.[at("Where")]).toBe("flag");
    expect(card.amount?.perRow?.column).toBe("Hours");
    expect(card.columns).toContain(card.amount?.perRow?.rateColumn ?? "");
  });

  test("a cpu card drops the GPU columns and keeps CPU perf", async () => {
    const card = await shown("cpu", ["pick-links", "pick-cells"]);
    for (const gone of GPU_COLUMNS) expect(card.columns).not.toContain(gone);
    expect(card.columns).toContain("CPU perf · /$");
    const perf = card.columns.indexOf("CPU perf · /$");
    expect(card.rows[2]?.[perf]).toMatch(/ · /);
    for (const grid of [card.rows, card.links, card.titles, card.cellKinds]) {
      for (const row of grid ?? []) expect(row).toHaveLength(card.columns.length);
    }
  });

  test("a gpu card has all 16 columns", async () => {
    const card = await shown("gpu");
    expect(card.columns).toEqual(COLUMNS);
  });

  test("the title says what the job needs", async () => {
    const card = await shown("io");
    expect(card.title).toContain("Needs: 1-2 threads: waits on Gemini");
  });

  test("an offer with no CPU reported shows not reported, never 0 × ?", async () => {
    const fake = vast([
      offer(1, 1, { cpu_cores_effective: 0 }),
      offer(2, 1, { cpu_name: "Xeon® Gold 6430" }),
    ]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call({ ...RENT, offers: [1, 2], need: "io" }, ctx);
    const cpu = cards[0]?.columns.indexOf("CPU") ?? -1;
    expect(cards[0]?.rows.map((row) => row[cpu])).toEqual(["not reported", "16 × Xeon Gold 6430"]);
    const noName = vast([offer(3, 1, { cpu_name: undefined })]);
    const listed = await (await setup(noName)).tool("vast_offers").call({}, ctxFor([]).ctx);
    expect(listed).toContain("not reported");
    expect(listed).not.toContain("0 ×");
  });

  test("a rent without need is refused", async () => {
    const { tool } = await world();
    const { need: _need, ...without } = RENT;
    await expect(tool("vast_rent").call(without, ctxFor([null]).ctx)).rejects.toThrow(/need/);
  });
});
