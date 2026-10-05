import { describe, expect, test } from "bun:test";
import { loadOf } from "../enforce";
import {
  cardLoad,
  GPU_HOLD_MS,
  GpuHold,
  type GpuReading,
  readLoad,
  showCores,
  showGpu,
  toneOf,
} from "../load";
import { IdleWatch } from "../rules";
import type { Instance } from "../vast-api";

const NOW = 1_800_000_000_000;
const M = 60_000;

/** Box #54190014 as measured 2026-10-05: one process on one of 384 cores, GPU busy. */
const busy: Instance = {
  id: 54190014,
  gpu_name: "RTX PRO 6000 S",
  num_gpus: 1,
  cpu_util: 0.2604,
  cpu_cores: 384,
  cpu_cores_effective: 384,
  gpu_util: 99.999908,
  gpu_temp: 72,
  vmem_usage: 76.9,
};
/** The same box, one read later in a dropout: zeros filled in for the GPU sample. */
const dropout: Instance = { ...busy, gpu_util: 0, gpu_temp: 0, vmem_usage: 0 };

/** What the card shows for a box at a time: its hover line and tone. */
const card = cardLoad;

describe("readLoad", () => {
  test("cpu_util is a share of all cores: 0.2604 of 384 is one core", () => {
    const reading = readLoad(busy);
    expect(reading.coresBusy).toBeCloseTo(1, 3);
    expect(reading.cores).toBe(384);
    expect(reading.cpuPct).toBeCloseTo(0.2604, 4);
    expect(reading.gpu).toBeCloseTo(99.999908, 5);
  });

  test("cpu_cores_effective is the allotment, cpu_cores the fallback for either", () => {
    expect(readLoad({ ...busy, cpu_cores: 400, cpu_cores_effective: 200 }).cores).toBe(200);
    expect(readLoad({ ...busy, cpu_cores_effective: null }).cores).toBe(384);
    expect(readLoad({ ...busy, cpu_cores: null }).coresBusy).toBeCloseTo(1, 3);
    expect(readLoad({ ...busy, cpu_cores: null, cpu_cores_effective: null })).toMatchObject({
      coresBusy: null,
      cores: null,
      cpuPct: null,
    });
  });

  test("no GPU, an unknown sample and a really idle GPU are told apart", () => {
    expect(readLoad({ id: 1, num_gpus: 0, gpu_util: 0 }).gpu).toBeNull();
    expect(readLoad({ id: 1, cpu_util: 3, cpu_cores: 8 }).gpu).toBeNull();
    expect(readLoad(dropout).gpu).toBe("unknown");
    expect(readLoad({ ...busy, gpu_temp: undefined, gpu_util: 0 }).gpu).toBe("unknown");
    expect(readLoad({ ...busy, gpu_util: 0, gpu_temp: 35 }).gpu).toBe(0);
  });
});

describe("the card", () => {
  test("a busy one-core box on 384 cores", () => {
    expect(card(busy, new GpuHold(), NOW).line).toBe(
      "CPU 1.0 of 384 cores · GPU 100 % (RTX PRO 6000 S)",
    );
  });

  test("a dropout shows the held reading, then ? once it is older than 5 minutes", () => {
    const hold = new GpuHold();
    card(busy, hold, NOW);
    expect(card(dropout, hold, NOW + 20_000).line).toBe(
      "CPU 1.0 of 384 cores · GPU 100 % (RTX PRO 6000 S)",
    );
    expect(card(dropout, hold, NOW + GPU_HOLD_MS).line).toContain("GPU 100 %");
    expect(card(dropout, hold, NOW + GPU_HOLD_MS + 1).line).toBe(
      "CPU 1.0 of 384 cores · GPU ? (RTX PRO 6000 S)",
    );
    // No reading was ever held: ?
    expect(card(dropout, new GpuHold(), NOW).line).toContain("GPU ?");
  });

  test("the held reading is not refreshed by a dropout, and forgotten with the box", () => {
    const hold = new GpuHold();
    card(busy, hold, NOW);
    card(dropout, hold, NOW + 4 * M);
    expect(card(dropout, hold, NOW + 6 * M).line).toContain("GPU ?");
    hold.keep(new Set());
    expect(card(dropout, hold, NOW + 6 * M).line).toContain("GPU ?");
    card(busy, hold, NOW + 7 * M);
    hold.keep(new Set());
    expect(card(dropout, hold, NOW + 8 * M).line).toContain("GPU ?");
  });

  test("a really idle GPU reads 0 %, a multi-GPU box says how many", () => {
    const idle: Instance = { ...busy, gpu_util: 0, gpu_temp: 35, num_gpus: 2 };
    expect(card(idle, new GpuHold(), NOW).line).toBe(
      "CPU 1.0 of 384 cores · GPU 0 % ×2 (RTX PRO 6000 S)",
    );
  });

  test("the tone uses the share of cores and the GPU, held value included", () => {
    const hold = new GpuHold();
    expect(card({ ...busy, gpu_util: 0, gpu_temp: 35 }, hold, NOW).tone).toBe("critical");
    expect(card(busy, hold, NOW).tone).toBe("good");
    expect(card(dropout, hold, NOW + M).tone).toBe("good");
    expect(card(dropout, hold, NOW + 10 * M).tone).toBe("critical");
    // Both unknown: muted, as before.
    expect(toneOf(null, "unknown")).toBe("muted");
    expect(toneOf(50, null)).toBe("warning");
  });

  test("a CPU-only box with no GPU fields reads as before", () => {
    const cpuOnly: Instance = { id: 2, num_gpus: 0, cpu_util: 50, cpu_cores: 8 };
    expect(card(cpuOnly, new GpuHold(), NOW)).toEqual({
      line: "CPU 4.0 of 8 cores · GPU ? (?)",
      tone: "warning",
    });
  });
});

describe("number formats", () => {
  test("cores to one decimal, <0.1 for a nonzero reading below 0.05", () => {
    expect(showCores(1.0001)).toBe("1.0");
    expect(showCores(0.04)).toBe("<0.1");
    expect(showCores(0.05)).toBe("0.1");
    expect(showCores(0)).toBe("0.0");
    expect(showCores(null)).toBe("?");
  });

  test("GPU rounded, <1 % for a nonzero reading that would show 0", () => {
    const cases: [GpuReading, string][] = [
      [99.999908, "100 %"],
      [0.4, "<1 %"],
      [0.5, "1 %"],
      [0, "0 %"],
      ["unknown", "?"],
      [null, "?"],
    ];
    for (const [gpu, text] of cases) expect(showGpu(gpu)).toBe(text);
  });
});

describe("the idle watch on a measured box", () => {
  test("one busy core of 384 is not idle; a dropout neither starts nor resets", () => {
    const watch = new IdleWatch();
    // CPU-only job: quiet GPU, cores busy 1.0.
    const job: Instance = { id: 5, num_gpus: 0, cpu_util: 0.2604, cpu_cores: 384 };
    expect(watch.observe(5, loadOf(job), NOW)).toBe(0);
    expect(watch.observe(5, loadOf(job), NOW + 30 * M)).toBe(0);

    const gpuBox = new IdleWatch();
    const still: Instance = { ...busy, cpu_util: 0, gpu_util: 0, gpu_temp: 35 };
    expect(gpuBox.observe(1, loadOf(dropout), NOW)).toBe(0);
    expect(gpuBox.observe(1, loadOf(still), NOW + M)).toBe(0);
    expect(gpuBox.observe(1, loadOf(still), NOW + 3 * M)).toBe(2 * M);
    expect(gpuBox.observe(1, loadOf(dropout), NOW + 4 * M)).toBe(3 * M);
    expect(gpuBox.observe(1, loadOf(still), NOW + 5 * M)).toBe(4 * M);
  });
});
