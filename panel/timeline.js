// "Lease timeline": one row per box, grouped by session or repository — when
// it started, each extension, its lease's end and how it ended.

import { clock, dayMs, esc, isQuiet, keyOf, money, titleOf } from "./model.js";

const H = 3_600_000;
const LEFT = 130;
const RIGHT = 150;
const ROW = 22;
const HEAD = 22;
const TOP_PAD = 26;
/** Reasons the extension (or Vast.ai) ended a box for, drawn in red. */
const FORCED = /budget|host|lease|broken/;

/** What each box cost in the range: its charges, else its rate times its run. */
function amountsOf(lines) {
  const byBox = new Map();
  for (const line of lines) {
    if (line.box !== null) byBox.set(line.box, (byBox.get(line.box) ?? 0) + line.amount);
  }
  return byBox;
}

function groupsOf(data, state, boxes, ranking) {
  const byKey = new Map();
  for (const box of boxes) {
    const key = keyOf(data, state.by, box.group);
    if (state.only !== null && key !== state.only) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), box]);
  }
  // Biggest first, the boxes with no session label last.
  const quiet = (key) => Number(isQuiet(data, state.by, key));
  return [...byKey.entries()].sort(
    (a, b) =>
      quiet(a[0]) - quiet(b[0]) ||
      (ranking.totals.get(b[0]) ?? 0) - (ranking.totals.get(a[0]) ?? 0),
  );
}

function windowOf(data, state, groups) {
  const shown = groups.flatMap(([, boxes]) => boxes);
  const rangeStart = dayMs(data.days.at(-state.range) ?? data.days[0]);
  const first = Math.min(...shown.map((b) => b.start));
  const t0 = Math.max(rangeStart, first - 2 * H);
  const ends = shown.filter((b) => b.end === null && b.until !== null).map((b) => b.until);
  const t1 = Math.min(Math.max(data.now + H, ...ends.map((u) => u + H)), data.now + 24 * H);
  return { t0, t1 };
}

function grid(x, t0, height) {
  const span = x.t1 - t0;
  const step = [3, 6, 12, 24, 48, 96].find((h) => span / (h * H) <= 9) ?? 168;
  let svg = "";
  for (let at = Math.ceil(t0 / (step * H)) * step * H; at < x.t1 - 2 * H; at += step * H) {
    svg += `<line x1="${x(at)}" y1="${TOP_PAD - 6}" x2="${x(at)}" y2="${height}" stroke="var(--grid)"/>`;
    svg += `<text x="${x(at) + 3}" y="12" class="muted">${esc(clock(at))}</text>`;
  }
  return svg;
}

function endMark(x, box, cy, now) {
  if (box.end === null) {
    const over = box.until !== null && box.until < now;
    return over
      ? `<text x="${x(now) + 8}" y="${cy + 4}" style="fill:var(--crit);font-size:10px">past its lease</text>`
      : "";
  }
  const ex = x(box.end);
  const forced = FORCED.test(box.reason ?? "");
  const colour = forced
    ? "var(--crit)"
    : box.reason === "gone from the list"
      ? "var(--muted-fg)"
      : "var(--fg)";
  const why = `Ended ${clock(box.end)}: ${box.reason ?? "?"}${box.by ? ` (by the ${box.by})` : ""}`;
  let svg = `<path d="M${ex - 4} ${cy - 4} L${ex + 4} ${cy + 4} M${ex + 4} ${cy - 4} L${ex - 4} ${cy + 4}" stroke="${colour}" stroke-width="2"/>`;
  svg += `<rect x="${ex - 6}" y="${cy - 6}" width="12" height="12" fill="transparent" data-tip="${esc(why)}"/>`;
  if (forced)
    svg += `<text x="${ex + 8}" y="${cy + 4}" style="fill:var(--crit);font-size:10px">${esc(box.reason)}</text>`;
  return svg;
}

function leaseMarks(x, box, cy, end) {
  let svg = "";
  if (box.until !== null && box.until < end) {
    svg += `<rect x="${x(box.until)}" y="${cy - 6}" width="${x(end) - x(box.until)}" height="12" fill="url(#hatch)"/>`;
  }
  if (box.firstUntil !== null && box.extensions.length > 0) {
    svg += `<line x1="${x(box.firstUntil)}" y1="${cy - 9}" x2="${x(box.firstUntil)}" y2="${cy + 9}" stroke="var(--muted-fg)" stroke-dasharray="2 2" data-tip="${esc(`First lease end ${clock(box.firstUntil)}`)}"/>`;
  }
  if (box.until !== null) {
    svg += `<line x1="${x(box.until)}" y1="${cy - 9}" x2="${x(box.until)}" y2="${cy + 9}" stroke="var(--fg)" stroke-dasharray="2 2" data-tip="${esc(`Lease ends ${clock(box.until)}`)}"/>`;
  }
  for (const ext of box.extensions) {
    const ex = x(ext.at);
    const added = ext.hours === null ? "" : `+${ext.hours.toFixed(ext.hours < 10 ? 1 : 0)}h`;
    svg += `<path d="M${ex} ${cy - 11} L${ex + 5} ${cy - 3} L${ex - 5} ${cy - 3} Z" fill="var(--warn)" data-tip="${esc(`Extended ${added} at ${clock(ext.at)}, to ${clock(ext.until)}`)}"/>`;
    if (added)
      svg += `<text x="${ex + 7}" y="${cy - 4}" style="fill:var(--warn);font-size:10px">${added}</text>`;
  }
  return svg;
}

function boxRow(ctx, box, y) {
  const { x, colour, amounts, now, width } = ctx;
  const end = box.end ?? now;
  const cy = y + ROW / 2;
  const amount = amounts.get(box.box) ?? box.cost;
  const cost = amount === null ? "" : money(amount);
  const budget = box.budget === null ? "" : ` of ${money(box.budget)} budget`;
  const rate = box.rate === null ? "" : ` · ${money(box.rate)}/h`;
  const tip = `${box.name} (#${box.box})\n${clock(box.start)} → ${box.end === null ? "running" : clock(box.end)}\n${cost}${budget}${rate}`;
  let svg = `<text x="16" y="${cy + 4}">${esc(box.name)}</text>`;
  svg += `<rect x="${x(box.start)}" y="${cy - 6}" width="${Math.max(2, x(end) - x(box.start))}" height="12" rx="3" fill="${colour}" opacity="0.85" data-tip="${esc(tip)}"/>`;
  svg += leaseMarks(x, box, cy, end);
  svg += `<circle cx="${x(box.start)}" cy="${cy}" r="4.5" fill="var(--fg)" data-tip="${esc(`Started ${clock(box.start)}${box.budget === null ? "" : ` · budget ${money(box.budget)}`}`)}"/>`;
  svg += endMark(x, box, cy, now);
  svg += `<text x="${width - 4}" y="${cy + 4}" text-anchor="end" class="muted">${cost}</text>`;
  return svg;
}

export function drawTimeline(el, note, data, state, lines, ranking) {
  const rangeStart = dayMs(data.days.at(-state.range) ?? data.days[0]);
  note.innerHTML =
    data.historyFrom === null || data.historyFrom > rangeStart
      ? `<div class="note">Leases are recorded from ${data.historyFrom === null ? "now on" : clock(data.historyFrom)}, when the history started; boxes before that show in the spend charts only.</div>`
      : "";
  const groups = groupsOf(data, state, data.boxes, ranking);
  if (groups.length === 0) {
    el.innerHTML = `<div class="empty">No box ran in this range${state.only === null ? "" : " for this one"}. Boxes appear here as soon as they are listed.</div>`;
    return;
  }
  const width = el.clientWidth || 1000;
  const { t0, t1 } = windowOf(data, state, groups);
  const x = (ms) => LEFT + ((Math.max(ms, t0) - t0) / (t1 - t0)) * (width - LEFT - RIGHT);
  x.t1 = t1;
  const rows = groups.reduce((n, [, boxes]) => n + 1 + boxes.length, 0);
  const height = TOP_PAD + rows * ROW + (groups.length - 1) * 6 + 8;
  const amounts = amountsOf(lines);
  let svg = grid(x, t0, height);
  svg += `<line x1="${x(data.now)}" y1="${TOP_PAD - 8}" x2="${x(data.now)}" y2="${height}" stroke="var(--now)" stroke-width="1.5"/><text x="${x(data.now) + 3}" y="${TOP_PAD - 10}" style="fill:var(--now)">now</text>`;
  let y = TOP_PAD;
  for (const [key, boxes] of groups) {
    const colour = ranking.colours.get(key) ?? "var(--s5)";
    const sum = boxes.reduce((n, b) => n + (amounts.get(b.box) ?? b.cost ?? 0), 0);
    svg += `<rect x="0" y="${y + 3}" width="4" height="${ROW * (boxes.length + 1) - 6}" fill="${colour}" rx="2"/>`;
    svg += `<text x="10" y="${y + 15}" class="head">${esc(titleOf(data, state.by, key))}</text><text x="${width - 4}" y="${y + 15}" text-anchor="end" class="head">${money(sum)}</text>`;
    y += HEAD;
    const ctx = { x, colour, amounts, now: data.now, width };
    for (const box of boxes) {
      svg += boxRow(ctx, box, y);
      y += ROW;
    }
    y += 6;
  }
  el.innerHTML = `<svg width="${width}" height="${height}"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--crit)" stroke-width="2"/></pattern></defs>${svg}</svg>`;
}
