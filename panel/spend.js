// "Spent per day / week": one stacked bar per bucket, a stack per group.

import {
  DAY,
  dayMs,
  dayText,
  dimmed,
  esc,
  money,
  OTHER,
  short,
  TOP,
  titleOf,
  weekOf,
} from "./model.js";

const HEIGHT = 230;
const LEFT = 52;
const RIGHT = 10;
const TOP_PAD = 18;
const BOTTOM = 26;
const STEPS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/** The buckets from the range's first day to today, each with its stacks. */
export function bucketsOf(data, state, lines, ranking) {
  const days = data.days.slice(-state.range);
  const first = dayMs(days[0]);
  const last = dayMs(days.at(-1));
  const step = state.bucket === "day" ? DAY : 7 * DAY;
  const start = state.bucket === "day" ? first : weekOf(first);
  const buckets = [];
  for (let ms = start; ms <= last; ms += step) {
    buckets.push({ ms, parts: new Map(), total: 0, partial: ms + step > data.now });
  }
  for (const line of lines) {
    const bucket = buckets[Math.floor((dayMs(line.day) - start) / step)];
    if (bucket === undefined) continue;
    const stack = ranking.stackOf(line.key);
    bucket.parts.set(stack, (bucket.parts.get(stack) ?? 0) + line.amount);
    bucket.total += line.amount;
  }
  return buckets;
}

/** The stacks bottom to top: biggest first, then the rest together, then the unlabelled. */
function orderOf(ranking) {
  const own = ranking.ranked.slice(0, TOP).map(([key]) => key);
  const quiet = [...ranking.totals.keys()].filter(
    (key) => !ranking.ranked.some(([k]) => k === key),
  );
  return [...own, OTHER, ...quiet];
}

function axis(width, top) {
  const y = (v) => TOP_PAD + (HEIGHT - TOP_PAD - BOTTOM) * (1 - v / top);
  let svg = "";
  for (let i = 0; i <= 4; i += 1) {
    const v = (top / 4) * i;
    svg += `<line x1="${LEFT}" x2="${width - RIGHT}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
    svg += `<text x="${LEFT - 6}" y="${y(v) + 4}" text-anchor="end" class="muted">$${v}</text>`;
  }
  return { svg, y };
}

function bar(ctx, bucket, i) {
  const { data, state, order, ranking, y, width: bw } = ctx;
  const x = LEFT + i * bw + bw * 0.14;
  const w = bw * 0.72;
  const when = state.bucket === "day" ? dayText(bucket.ms) : `Week of ${dayText(bucket.ms)}`;
  const tip = [`${when}${bucket.partial ? " (so far)" : ""}: ${money(bucket.total)}`];
  let svg = "";
  let base = y(0);
  for (const key of order) {
    const value = bucket.parts.get(key);
    if (!value) continue;
    const h = Math.max(y(0) - y(value), 0.5);
    const fill = ranking.colours.get(key);
    svg += `<rect x="${x}" y="${base - h}" width="${w}" height="${h}" fill="${fill}" opacity="${dimmed(state, key) ? 0.18 : 1}"/>`;
    if (bucket.partial)
      svg += `<rect x="${x}" y="${base - h}" width="${w}" height="${h}" fill="url(#partial)"/>`;
    base -= h;
    tip.push(`${titleOf(data, state.by, key, ranking.others)}: ${money(value)}`);
  }
  if (bucket.total > 0 && bw > 30) {
    svg += `<text x="${x + w / 2}" y="${base - 4}" text-anchor="middle" class="muted">${short(bucket.total)}</text>`;
  }
  svg += `<rect x="${LEFT + i * bw}" y="${TOP_PAD}" width="${bw}" height="${HEIGHT - TOP_PAD - BOTTOM}" fill="transparent" data-tip="${esc(tip.join("\n"))}"/>`;
  if (i % ctx.every === 0) {
    svg += `<text x="${LEFT + i * bw + bw / 2}" y="${HEIGHT - 8}" text-anchor="middle" class="muted">${dayText(bucket.ms)}</text>`;
  }
  return svg;
}

export function drawSpend(el, legend, data, state, lines, ranking) {
  if (lines.length === 0) {
    el.innerHTML = `<div class="empty">Nothing billed in this range.</div>`;
    legend.innerHTML = "";
    return;
  }
  const buckets = bucketsOf(data, state, lines, ranking);
  const width = el.clientWidth || 1200;
  const max = Math.max(...buckets.map((b) => b.total));
  const top = 4 * (STEPS.find((s) => s * 4 >= max) ?? Math.ceil(max / 4));
  const { svg: grid, y } = axis(width, top);
  const order = orderOf(ranking);
  const bw = (width - LEFT - RIGHT) / buckets.length;
  const ctx = { data, state, order, ranking, y, width: bw, every: Math.ceil(buckets.length / 16) };
  const bars = buckets.map((bucket, i) => bar(ctx, bucket, i)).join("");
  el.innerHTML = `<svg width="${width}" height="${HEIGHT}"><defs><pattern id="partial" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--card)" stroke-width="2" opacity=".6"/></pattern></defs>${grid}${bars}</svg>`;
  const shown = order.filter((key) => buckets.some((b) => b.parts.get(key)));
  legend.innerHTML =
    shown
      .map(
        (key) =>
          `<span ${key === OTHER ? "" : `data-k="${esc(key)}"`} style="${dimmed(state, key) ? "opacity:.45" : ""}"><i style="background:${ranking.colours.get(key)}"></i>${esc(titleOf(data, state.by, key, ranking.others))}</span>`,
      )
      .join("") +
    `<span><i style="background:repeating-linear-gradient(45deg,var(--muted-fg) 0 2px,transparent 2px 5px)"></i>${state.bucket === "day" ? "today" : "this week"} so far</span>`;
}
