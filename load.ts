/**
 * One reading of how hard a box is working, shared by the card, its tone and
 * the idle watch, so they cannot disagree about it. Two things the list
 * endpoint does that a plain `cpu_util` / `gpu_util` read gets wrong (measured
 * 2026-10-05 against the live API, box #54190014, 1 GPU busy at 100 %):
 *
 * - `cpu_util` is a percentage of ALL the box's cores. One process at 100 % of
 *   one core on a 384-core host came back as `cpu_util 0.2604` (100 / 384).
 *   Shown as a percentage it rounded to "CPU 0 %", and a few busy cores of a
 *   big host read as idle. Cores busy is `cpu_util / 100 × cpu_cores`.
 * - In 5 of 36 reads 10–20 s apart (runs of 1–2), the row had `gpu_util`,
 *   `gpu_temp` and `vmem_usage` all exactly 0.0 while the next read, and
 *   `GET /api/v0/instances/<id>/` in the same second, had the real values. A
 *   missing GPU sample is filled with zeros. A running GPU is never at 0 °C,
 *   so a `gpu_temp` of 0 or none on a box with GPUs means "no sample", not
 *   "idle". A really idle GPU reads util 0 at a real temperature (~30–40 °C).
 */

import type { DecorationTone } from "./prifly-api";
import type { Instance } from "./vast-api";

/** The GPU's share in %; null: the box has no GPU; "unknown": no sample this read. */
export type GpuReading = number | null | "unknown";

export type Reading = {
  /** Cores' worth of work: `cpu_util / 100 × cpu_cores`. Null when unknown. */
  coresBusy: number | null;
  /** The box's own cores. */
  cores: number | null;
  /** `coresBusy` as a share of `cores`, in %. */
  cpuPct: number | null;
  gpu: GpuReading;
};

const num = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function readLoad(box: Instance): Reading {
  // `cpu_cores` and `cpu_cores_effective` were equal (384) on the box measured,
  // so which one `cpu_util` is a share of could not be told apart. Cores busy
  // uses `cpu_cores`, then `cpu_cores_effective`; the allotment shown is the
  // effective one, then `cpu_cores`.
  const util = num(box.cpu_util);
  const total = num(box.cpu_cores) ?? num(box.cpu_cores_effective);
  const cores = num(box.cpu_cores_effective) ?? num(box.cpu_cores);
  const coresBusy = util === null || total === null ? null : (util / 100) * total;
  const cpuPct =
    coresBusy === null || cores === null || cores <= 0 ? null : (coresBusy / cores) * 100;
  return { coresBusy, cores, cpuPct, gpu: gpuOf(box) };
}

function gpuOf(box: Instance): GpuReading {
  if ((num(box.num_gpus) ?? 0) < 1) return null;
  const util = num(box.gpu_util);
  const temp = num(box.gpu_temp);
  if (util === null || temp === null || temp <= 0) return "unknown";
  return util;
}

/** How long a real GPU reading stands in for a dropped one. */
export const GPU_HOLD_MS = 5 * 60_000;

/** The last real GPU reading of each box, to show while the list drops out. */
export class GpuHold {
  readonly #last = new Map<number, { pct: number; at: number }>();

  /** `gpu` as it should show: a dropout becomes the held reading, up to `GPU_HOLD_MS` old. */
  resolve(id: number | undefined, gpu: GpuReading, now: number): GpuReading {
    if (id === undefined) return gpu;
    if (gpu !== "unknown") {
      if (gpu !== null) this.#last.set(id, { pct: gpu, at: now });
      return gpu;
    }
    const held = this.#last.get(id);
    return held !== undefined && now - held.at <= GPU_HOLD_MS ? held.pct : "unknown";
  }

  /** Forget the boxes that are gone. */
  keep(boxes: ReadonlySet<number>): void {
    for (const id of this.#last.keys()) if (!boxes.has(id)) this.#last.delete(id);
  }
}

/** "1.0", "<0.1" for a nonzero reading below 0.05, "?" when unknown. */
export function showCores(value: number | null): string {
  if (value === null) return "?";
  return value > 0 && value < 0.05 ? "<0.1" : value.toFixed(1);
}

/** "100 %", "<1 %" for a nonzero reading that would round to 0, "?" when unknown. */
export function showGpu(gpu: GpuReading): string {
  if (gpu === null || gpu === "unknown") return "?";
  return gpu > 0 && gpu < 0.5 ? "<1 %" : `${Math.round(gpu)} %`;
}

/** Under this share of the box's cores or GPU, a rented box is idle; from `BUSY_PCT` it is busy. */
const IDLE_PCT = 20;
const BUSY_PCT = 80;

/**
 * A rented box is paid to work: idle red, busy green, amber between. The
 * peak of the CPU's share and the GPU's counts; an unknown reading is left out.
 */
export function toneOf(cpuPct: number | null, gpu: GpuReading): DecorationTone {
  const readings = [cpuPct, gpu].filter((value): value is number => typeof value === "number");
  if (readings.length === 0) return "muted";
  const peak = Math.max(...readings);
  if (peak < IDLE_PCT) return "critical";
  return peak >= BUSY_PCT ? "good" : "warning";
}

/**
 * What the card shows of a box's load: the hover line, e.g.
 * `CPU 1.0 of 384 cores · GPU 100 % ×2 (RTX PRO 6000 S)`, and the tone. A GPU
 * dropout shows the last real reading held in `hold`.
 */
export function cardLoad(
  box: Instance,
  hold: GpuHold,
  now: number,
): { line: string; tone: DecorationTone } {
  const reading = readLoad(box);
  const gpu = hold.resolve(box.id, reading.gpu, now);
  const of = reading.cores === null ? "" : ` of ${reading.cores}`;
  const many = (box.num_gpus ?? 0) > 1 ? ` ×${box.num_gpus}` : "";
  return {
    line: `CPU ${showCores(reading.coresBusy)}${of} cores · GPU ${showGpu(gpu)}${many} (${box.gpu_name ?? "?"})`,
    tone: toneOf(reading.cpuPct, gpu),
  };
}
