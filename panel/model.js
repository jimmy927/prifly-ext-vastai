// What the three charts share: the groups by session or repository, their
// totals in the range and their colours, so a group has one colour everywhere.

export const DAY = 86_400_000;
/**
 * Colours for the biggest groups; the rest share "other", the unlabelled
 * grey. Red (`--s7`) is left out: it marks a box ended for its budget.
 */
const PALETTE = ["--s0", "--s1", "--s2", "--s3", "--s4", "--s6"];
export const TOP = PALETTE.length;
export const OTHER = "__other";
const OTHER_COLOUR = "var(--s5)";
const QUIET_COLOUR = "var(--other)";

/** The key a box's group has when grouping `by` session or repository. */
export function keyOf(data, by, group) {
  return by === "session" ? group : (data.groups[group]?.repo ?? group);
}

/** Boxes with no session label: shown last, in grey. */
export function isQuiet(data, by, key) {
  if (by === "session") return data.groups[key]?.kind === "none";
  return key === "No session label";
}

export function titleOf(data, by, key, count = 0) {
  if (key === OTHER) return `${count} more ${by === "session" ? "sessions" : "repositories"}`;
  return by === "session" ? (data.groups[key]?.title ?? key) : key;
}

/** The second line under a group's name. */
export function subOf(data, by, key) {
  if (by === "repo") {
    if (isQuiet(data, by, key)) return "rented without the tools";
    const sessions = new Set(
      Object.entries(data.groups)
        .filter(([, g]) => g.repo === key && g.session !== null)
        .map(([k]) => k),
    );
    return `${sessions.size} session${sessions.size === 1 ? "" : "s"}`;
  }
  const group = data.groups[key];
  if (group === undefined || group.kind === "none") return "rented without the tools";
  return group.session === null ? group.repo : `${group.repo} · ${group.session}`;
}

/** The charge lines in the range, each with its key. */
export function linesOf(data, state) {
  const from = data.days.at(-state.range) ?? data.days[0];
  return data.charges
    .filter((line) => line.day >= from)
    .map((line) => ({ ...line, key: keyOf(data, state.by, line.group) }));
}

/**
 * Each key's total, ranked; the colour of each; and which stack a key is
 * drawn in (the biggest `TOP` their own, the rest together).
 */
export function rank(data, state, lines) {
  const totals = new Map();
  for (const line of lines) totals.set(line.key, (totals.get(line.key) ?? 0) + line.amount);
  const ranked = [...totals.entries()]
    .filter(([key]) => !isQuiet(data, state.by, key))
    .sort((a, b) => b[1] - a[1]);
  const colours = new Map();
  ranked.forEach(([key], i) => {
    colours.set(key, i < TOP ? `var(${PALETTE[i]})` : OTHER_COLOUR);
  });
  for (const key of totals.keys()) if (isQuiet(data, state.by, key)) colours.set(key, QUIET_COLOUR);
  colours.set(OTHER, OTHER_COLOUR);
  const own = new Set(ranked.slice(0, TOP).map(([key]) => key));
  const stackOf = (key) => (own.has(key) || isQuiet(data, state.by, key) ? key : OTHER);
  return { totals, ranked, colours, stackOf, others: Math.max(0, ranked.length - TOP) };
}

/** Whether a key is dimmed by the reader's choice of one alone. */
export function dimmed(state, key) {
  return state.only !== null && state.only !== key;
}

export function money(n) {
  return `$${n.toFixed(2)}`;
}

/** "$301", or "$4.62": no cents once it is in the hundreds. */
export function short(n) {
  return n >= 100 ? `$${Math.round(n)}` : money(n);
}

export function dayMs(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

/** "5 Oct", of a UTC day. */
export function dayText(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "Mon 14:00", in the reader's own time. */
export function clock(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Monday of a UTC day's week. */
export function weekOf(ms) {
  return ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
}

/** Text made safe to put in HTML. */
export function esc(text) {
  return String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
