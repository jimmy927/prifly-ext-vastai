// The panel's machine cards: one per box, from `api/boxes` (`fleet.ts`),
// running ones apart from the stopped ones that only keep (and bill) a disk.
// A card's buttons post `api/action`, the same actions as the box's menu;
// "Go to session" asks the window to open the session that rented it, on a
// prifly that can (`openSession`).

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const rate = (n) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}/h`;

function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)} d`;
}

/** Who the box is: its session, another prifly's, or rented by hand. */
function whose(box, canOpen) {
  if (box.session !== null) {
    const known = box.session.id !== null;
    const open =
      known && canOpen
        ? `<button type="button" class="plain small" data-open="${esc(box.session.id)}">Go to session</button>`
        : "";
    const note = known ? "" : `<span class="dim"> · not a session of this prifly</span>`;
    return `<div class="who"><span class="dim">Session</span> <b>${esc(box.session.title)}</b> <code>${esc(box.session.short)}</code>${note}${open}</div>`;
  }
  if (box.owner.kind === "foreign") {
    return `<div class="who dim">${esc(box.owner.name)}'s prifly: never managed here</div>`;
  }
  return `<div class="who dim">No session: rented by hand or by other software</div>`;
}

function spendBar(box) {
  if (box.spent === null || box.budget === null || box.budget <= 0) return "";
  const share = Math.min(1, box.spent / box.budget);
  const tone = share >= 1 ? "crit" : share >= 0.9 ? "warn" : "ok";
  return `<div class="budget"><div class="track"><div class="fill ${tone}" style="width:${(share * 100).toFixed(1)}%"></div></div><span>$${box.spent.toFixed(2)} of $${box.budget}</span></div>`;
}

/** "RTX 4090 · 40 GB disk · Quebec, CA · up 3h 10m · #54190014" */
function facts(box, now) {
  const disk = box.state === "disk";
  const gpu = box.gpu === "" ? "CPU" : `${box.gpus > 1 ? `${box.gpus}× ` : ""}${esc(box.gpu)}`;
  return [
    gpu,
    box.diskGb === null ? "" : `${Math.round(box.diskGb)} GB disk`,
    box.place === "" ? "" : esc(box.place),
    box.startedAt === null ? "" : `${disk ? "rented" : "up"} ${ago(now - box.startedAt)}`,
    `#${box.id ?? "?"}`,
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

function price(box) {
  if (box.state !== "disk") return rate(box.rate);
  return `${box.diskRate === null ? "?" : rate(box.diskRate)} <span class="dim">disk</span>`;
}

function leaseLine(box) {
  if (box.lease === null) return "";
  const tip = esc(box.lease.details.join("\n"));
  const text = esc(box.lease.details[0] ?? box.lease.short);
  return `<div class="lease t-${box.lease.tone ?? "plain"}" data-tip="${tip}">${text}</div>`;
}

function sshLine(box) {
  if (box.ssh === null) return "";
  const cmd = esc(box.ssh);
  return `<div class="ssh"><code title="${cmd}">${cmd}</code><button type="button" class="plain small" data-copy="${cmd}">Copy</button></div>`;
}

/** Extend, while the lease rules act on it; Destroy, asked again on the card itself. */
function buttons(box, ui) {
  const key = esc(box.key);
  const off = ui.busy.has(box.key) ? "disabled" : "";
  const extend = box.extendable
    ? `<button type="button" class="plain small" data-act="extend1" data-key="${key}" ${off}>+1 h</button><button type="button" class="plain small" data-act="extend4" data-key="${key}" ${off}>+4 h</button>`
    : "";
  const destroy =
    ui.confirm === box.key
      ? `<span class="ask">Delete ${esc(box.name)} and its disk?</span><button type="button" class="plain small danger solid" data-act="destroy" data-key="${key}" ${off}>Destroy</button><button type="button" class="plain small" data-cancel>Keep</button>`
      : `<button type="button" class="plain small danger" data-ask="${key}" ${off}>Destroy…</button>`;
  return `${extend}<span class="grow"></span>${destroy}`;
}

function card(box, ui, canOpen, now) {
  const disk = box.state === "disk";
  const tone = disk ? "warning" : (box.lease?.tone ?? box.load?.tone ?? "muted");
  const badge = box.state === "running" ? "running" : box.status;
  const load = box.load === null ? "" : `<div class="load dim">${esc(box.load.line)}</div>`;
  const stopped = disk
    ? `<div class="note-line">Stopped: the GPU is released, the disk is kept and billed until the box is destroyed.</div>`
    : "";
  return `<article class="box s-${box.state}">
    <header><span class="dot t-${tone}"></span><b class="bname">${esc(box.name)}</b><span class="badge b-${box.state}">${esc(badge)}</span><span class="grow"></span><span class="price">${price(box)}</span></header>
    <div class="facts dim">${facts(box, now)}</div>
    ${whose(box, canOpen)}
    ${stopped}${leaseLine(box)}${spendBar(box)}${load}${sshLine(box)}
    <footer>${buttons(box, ui)}</footer>
  </article>`;
}

function section(title, sub, boxes, ui, canOpen, now) {
  if (boxes.length === 0) return "";
  return `<div class="mgroup"><h3>${title} <span class="dim">${boxes.length}</span></h3><div class="msub dim">${sub}</div><div class="mgrid">${boxes.map((b) => card(b, ui, canOpen, now)).join("")}</div></div>`;
}

export function drawMachines(el, answer, ui) {
  if (answer === null) {
    el.innerHTML = `<div class="dim">Reading the boxes…</div>`;
    return;
  }
  const { boxes, openSession, now } = answer;
  if (boxes.length === 0) {
    el.innerHTML = `<div class="dim">No boxes on the account: nothing is billing.</div>`;
    return;
  }
  const live = boxes.filter((b) => b.state !== "disk");
  const disks = boxes.filter((b) => b.state === "disk");
  const burn = live.reduce((n, b) => n + b.rate, 0);
  const diskBurn = disks.reduce((n, b) => n + (b.diskRate ?? 0), 0);
  el.innerHTML =
    section("Running", `Billing ${rate(burn)} together.`, live, ui, openSession, now) +
    section(
      "Disk only",
      `Stopped, billing ${rate(diskBurn)} for their disks. Destroy what you no longer need.`,
      disks,
      ui,
      openSession,
      now,
    );
}
