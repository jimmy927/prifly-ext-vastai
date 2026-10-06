// The Vast.ai panel: every box as a card with its actions (`machines.js`,
// from `api/boxes`), then what boxes cost per day or week, who spent it, and
// each box's lease on a timeline (`api/data?days=<n>`). Both are answered by
// the extension (`spend-panel.ts`).

import { drawBurn } from "./burn.js";
import { drawMachines } from "./machines.js";
import { dayMs, dayText, linesOf, money, rank, titleOf } from "./model.js";
import { drawSpend } from "./spend.js";
import { drawTimeline } from "./timeline.js";

const SAVED = "vastai-spend";
const $ = (id) => document.getElementById(id);

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? "{}");
  } catch {
    return {};
  }
}

const saved = readSaved();
const state = {
  range: [7, 30, 90].includes(saved.range) ? saved.range : 30,
  bucket: saved.bucket === "week" ? "week" : "day",
  by: saved.by === "repo" ? "repo" : "session",
  only: null,
  allBurners: false,
};
/** The answer for the most days asked so far: a shorter range is a slice of it. */
let data = null;
let error = null;
let loading = false;

function save() {
  try {
    localStorage.setItem(
      SAVED,
      JSON.stringify({ range: state.range, bucket: state.bucket, by: state.by }),
    );
  } catch {
    // A private window: the choices last until the panel closes.
  }
}

async function load(force = false) {
  if (!force && data !== null && data.days.length >= state.range) return;
  loading = true;
  draw();
  try {
    const response = await fetch(`api/data?days=${Math.max(state.range, data?.days.length ?? 0)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    data = body;
    error = null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading = false;
  }
  draw();
}

/** The boxes now, and what the cards are doing: a box being acted on, the one asking to destroy. */
let machines = null;
const ui = { busy: new Set(), confirm: null, said: null };

async function loadMachines() {
  try {
    const response = await fetch("api/boxes");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    machines = body;
  } catch (caught) {
    ui.said = {
      bad: true,
      text: `Could not read the boxes: ${caught instanceof Error ? caught.message : caught}`,
    };
  }
  drawCards();
}

function drawCards() {
  $("mnote").innerHTML =
    ui.said === null ? "" : `<div class="note${ui.said.bad ? " bad" : ""}">${ui.said.text}</div>`;
  drawMachines($("machines"), machines, ui);
}

async function act(key, action) {
  ui.busy.add(key);
  ui.confirm = null;
  drawCards();
  try {
    const response = await fetch("api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, action }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    ui.said = { bad: false, text: body.message };
  } catch (caught) {
    ui.said = { bad: true, text: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    ui.busy.delete(key);
  }
  await loadMachines();
}

function cardClicks() {
  $("machines").onclick = (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const { open, copy, ask, act: action, key } = button.dataset;
    if (open !== undefined) parent.postMessage({ type: "prifly-open-session", session: open }, "*");
    if (copy !== undefined) {
      void navigator.clipboard?.writeText(copy).then(
        () => {
          button.textContent = "Copied";
          setTimeout(() => (button.textContent = "Copy"), 1500);
        },
        () => {},
      );
    }
    if (ask !== undefined) {
      ui.confirm = ask;
      drawCards();
    }
    if (button.hasAttribute("data-cancel")) {
      ui.confirm = null;
      drawCards();
    }
    if (action !== undefined && key !== undefined) void act(key, action);
  };
}

function tiles(lines, ranking) {
  const total = lines.reduce((n, l) => n + l.amount, 0);
  const quiet = [...ranking.totals.entries()]
    .filter(([key]) => !ranking.ranked.some(([k]) => k === key))
    .reduce((n, [, v]) => n + v, 0);
  $("tSpentK").textContent = `Spent, last ${state.range} days`;
  $("tSpent").textContent = money(total);
  $("tSpentS").textContent =
    `${money(total - quiet)} by sessions · ${money(quiet)} without a session label`;
  $("tBurn").textContent = `${money(data.live.burn)}/h`;
  const names = data.live.names;
  $("tBurnS").textContent =
    names.length === 0
      ? "nothing running"
      : `${names.length} running · ${names.slice(0, 4).join(", ")}`;
  const top = ranking.ranked[0];
  $("tTop").textContent = top ? money(top[1]) : "–";
  $("tTopS").textContent = top ? titleOf(data, state.by, top[0]) : "nothing billed";
  const perDay = new Map();
  for (const line of lines) perDay.set(line.day, (perDay.get(line.day) ?? 0) + line.amount);
  const peak = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
  $("tAvg").textContent = money(total / state.range);
  $("tAvgS").textContent = peak ? `peak ${money(peak[1])} on ${dayText(dayMs(peak[0]))}` : "";
}

function notes() {
  const out = [];
  if (error !== null) out.push(`<div class="note bad">Could not read the spend: ${error}</div>`);
  if (loading) {
    out.push(
      `<div class="note">Asking Vast.ai for the charges, one day at a time — the first time takes a little while; days that are over are kept.</div>`,
    );
  }
  if (data !== null && data.failed.length > 0) {
    out.push(
      `<div class="note bad">Vast.ai did not answer for ${data.failed.length} day(s) (${data.failed.slice(0, 5).join(", ")}): they are missing from the charts. Refresh asks again.</div>`,
    );
  }
  $("notes").innerHTML = out.join("");
  $("stamp").textContent =
    data === null
      ? ""
      : `Amounts per UTC day · read ${new Date(data.now).toLocaleTimeString([], { timeStyle: "short" })}`;
}

function choose(only, allBurners = state.allBurners) {
  state.only = only;
  state.allBurners = allBurners;
  draw();
}

function draw() {
  for (const [id, value] of [
    ["range", state.range],
    ["bucket", state.bucket],
    ["by", state.by],
  ]) {
    for (const button of $(id).querySelectorAll("button")) {
      button.classList.toggle("on", button.dataset.v === String(value));
    }
  }
  notes();
  if (data === null) return;
  const word = state.by === "session" ? "session" : "repository";
  for (const el of document.querySelectorAll(".byWord")) el.textContent = word;
  $("spendTitle").textContent = state.bucket === "day" ? "Spent per day" : "Spent per week";
  $("burnTitle").textContent = `Who is burning it — by ${word}`;
  const lines = linesOf(data, state);
  const ranking = rank(data, state, lines);
  tiles(lines, ranking);
  drawSpend($("spend"), $("spendLegend"), data, state, lines, ranking);
  drawBurn($("burn"), data, state, lines, ranking, choose);
  drawTimeline($("tl"), $("tlNote"), data, state, lines, ranking);
}

function controls() {
  const on = (id, set) => {
    for (const button of $(id).querySelectorAll("button")) {
      button.onclick = () => {
        set(button.dataset.v);
        save();
        draw();
        void load();
      };
    }
  };
  on("range", (v) => {
    state.range = Number(v);
    state.bucket = state.range > 30 ? "week" : "day";
  });
  on("bucket", (v) => {
    state.bucket = v;
  });
  on("by", (v) => {
    state.by = v;
    state.only = null;
    state.allBurners = false;
  });
  $("reload").onclick = () => {
    void load(true);
    void loadMachines();
  };
  $("spendLegend").onclick = (event) => {
    const key = event.target.closest("[data-k]")?.dataset.k;
    if (key !== undefined) choose(state.only === key ? null : key);
  };
}

function tooltips() {
  const tip = $("tip");
  document.addEventListener("mousemove", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (!target) {
      tip.style.display = "none";
      return;
    }
    tip.style.display = "block";
    tip.textContent = target.getAttribute("data-tip");
    tip.style.left = `${Math.min(event.clientX + 12, innerWidth - 370)}px`;
    tip.style.top = `${Math.min(event.clientY + 14, innerHeight - tip.offsetHeight - 4)}px`;
  });
}

// The window's own colours and font, as token-stats takes them.
const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};
addEventListener("message", (event) => {
  if (event.data?.type !== "prifly-look") return;
  document.documentElement.classList.toggle("dark", event.data.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = event.data.tokens?.[theirs];
    if (typeof value === "string" && value !== "") {
      document.documentElement.style.setProperty(ours, value);
    }
  }
  draw();
});
let resizing = 0;
addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(draw, 100);
});
// Today's bar grows: read again every ten minutes while the panel is open.
setInterval(() => void load(true), 10 * 60_000);
// The boxes are listed once a minute by the extension: the cards follow.
setInterval(() => void loadMachines(), 30_000);

controls();
cardClicks();
tooltips();
void loadMachines();
void load();
