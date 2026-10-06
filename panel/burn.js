// "Who is burning it": one row per session or repository, biggest first, each
// box a segment of its bar.

import { dimmed, esc, isQuiet, money, subOf, titleOf } from "./model.js";

/** Rows shown before the rest fold into one. */
const SHOWN = 8;

/** Each key's boxes and what each cost in the range, biggest first. */
function boxesOf(lines) {
  const byKey = new Map();
  for (const line of lines) {
    const boxes = byKey.get(line.key) ?? new Map();
    byKey.set(line.key, boxes);
    const id = line.box ?? line.name;
    const box = boxes.get(id) ?? { name: line.name, amount: 0 };
    box.amount += line.amount;
    boxes.set(id, box);
  }
  return byKey;
}

function segments(boxes, max, colour) {
  return [...boxes.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((box, i) => {
      const width = (box.amount * 100) / max;
      const opacity = 1 - Math.min(i, 5) * 0.13;
      return `<div class="seg" data-tip="${esc(`${box.name}: ${money(box.amount)}`)}" style="width:${width}%;background:${colour};opacity:${opacity}"></div>`;
    })
    .join("");
}

function row(html, className, onClick) {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  if (onClick) el.onclick = onClick;
  return el;
}

function classOf(data, state, key) {
  const chosen = state.only === key ? " sel" : dimmed(state, key) ? " dim" : "";
  return `burn-row${chosen}${isQuiet(data, state.by, key) ? " quiet" : ""}`;
}

export function drawBurn(el, data, state, lines, ranking, choose) {
  el.innerHTML = "";
  if (lines.length === 0) {
    el.innerHTML = `<div class="empty">No box has billed in this range.</div>`;
    return;
  }
  const byKey = boxesOf(lines);
  const quiet = [...ranking.totals.entries()].filter(([key]) => isQuiet(data, state.by, key));
  const folded = !state.allBurners && ranking.ranked.length > SHOWN;
  const named = folded ? ranking.ranked.slice(0, SHOWN - 1) : ranking.ranked;
  const max = Math.max(...[...ranking.totals.values()]);
  for (const [key, total] of [...named, ...quiet]) {
    const colour = ranking.colours.get(key);
    const className = classOf(data, state, key);
    const html = `<div class="name">${esc(titleOf(data, state.by, key))}<small>${esc(subOf(data, state.by, key))}</small></div><div class="track">${segments(byKey.get(key) ?? new Map(), max, colour)}</div><div class="amt">${money(total)}</div>`;
    el.appendChild(row(html, className, () => choose(state.only === key ? null : key)));
  }
  if (folded) {
    const rest = ranking.ranked.slice(SHOWN - 1);
    const sum = rest.reduce((n, [, v]) => n + v, 0);
    const html = `<div class="name">${rest.length} more ${state.by === "session" ? "sessions" : "repositories"}<small>click to list them</small></div><div class="track"><div class="seg" style="width:${(sum * 100) / max}%;background:var(--s5)"></div></div><div class="amt">${money(sum)}</div>`;
    el.insertBefore(
      row(html, "burn-row", () => choose(state.only, true)),
      el.children[named.length] ?? null,
    );
  }
}
