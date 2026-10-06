/**
 * The boxes as the panel's machine cards (`panel/machines.js`), and the one
 * item the status bar keeps for them: the panel's own button.
 *
 * A box shows on the session that rented it, in the sidebar and under the
 * goal. Every box is also a card in the panel, with what the chip only hints
 * at on hover: its session, lease, spend, load, disk and ssh, and its actions.
 * A box no session here holds — rented by hand, another prifly's, or a
 * session this prifly does not know — used to be a chip in the status bar;
 * now it is only in the panel, and colours the panel's button.
 *
 * A box is one of three states, because they bill differently:
 * - `running`: billing its whole rate (`dph_total`);
 * - `starting`: asked to run, not running yet (loading its image);
 * - `disk`: stopped or exited, billing only its disk (`storage_total_cost`)
 *   until it is destroyed.
 */

import { type Worker, workerOf } from "./endpoints";
import type { Judged } from "./enforce";
import { cardLoad, type GpuHold } from "./load";
import { isManaged, leaseLine } from "./machine-card";
import type { Decoration, DecorationTone, ExtensionSession } from "./prifly-api";
import { parseLabel } from "./rules";
import { sshCommand, sshTarget } from "./run";
import type { Instance } from "./vast-api";

export type BoxState = "running" | "starting" | "disk";

export type BoxCard = {
  /** The key the chip's and card's actions go by: the instance id. */
  key: string;
  id: number | null;
  name: string;
  label: string;
  state: BoxState;
  /** Vast.ai's own word for it: "running", "loading", "exited". */
  status: string;
  /** Dollars an hour while running, disk included. */
  rate: number;
  /** Dollars an hour for the disk alone: what it bills stopped. */
  diskRate: number | null;
  diskGb: number | null;
  gpu: string;
  gpus: number;
  place: string;
  /** "CPU 1.0 of 32 cores · GPU 97 % (RTX 4090)" and its colour; null when not running. */
  load: { line: string; tone: DecorationTone } | null;
  /** The session that rented it: its full id when this prifly knows it. */
  session: { short: string; id: string | null; title: string } | null;
  /** Whose it is: this prifly's, another prifly's (`owner`), a serverless endpoint's, or nobody's. */
  owner: { kind: "mine" | "foreign" | "serverless" | "none"; name: string | null };
  /** The endpoint a serverless worker works for; null for any other box. */
  serverless: Worker | null;
  lease: { short: string; tone: DecorationTone | null; details: string[] } | null;
  spent: number | null;
  budget: number | null;
  /** Epoch ms. */
  startedAt: number | null;
  endsAt: number | null;
  ssh: string | null;
  /** The lease rules act on it, so "Extend" applies. */
  extendable: boolean;
};

/** Running, starting, or only a disk left. */
export function stateOf(box: Instance): BoxState {
  const actual = box.actual_status ?? null;
  if (actual === "running") return "running";
  const wanted = box.intended_status ?? null;
  const settled = actual === "exited" || actual === "stopped" || actual === "offline";
  return wanted === "running" && !settled ? "starting" : "disk";
}

/**
 * Which of this prifly's sessions rented a box, and what to call it, from its
 * `<owner>/s-<session8>/<name>` label (or the older `s-<session8>/<name>`). A
 * box of another owner has no session here: that prifly's session ids mean
 * nothing on this one, so it is named with its owner.
 */
export function ownerOf(
  box: Instance,
  owner: string,
): { session: string | null; name: string; foreign: string | null } {
  const label = box.label ?? "";
  const parsed = parseLabel(label);
  // A serverless worker goes by its endpoint's name; its session comes from a claim.
  const worker = parsed === null ? workerOf(label) : null;
  if (worker !== null) return { session: null, name: worker.endpoint, foreign: null };
  if (parsed === null) {
    return { session: null, name: label || `#${box.id ?? "?"}`, foreign: null };
  }
  if (parsed.owner !== null && parsed.owner !== owner) {
    return { session: null, name: `${parsed.owner}/${parsed.name}`, foreign: parsed.owner };
  }
  return { session: parsed.session, name: parsed.name, foreign: null };
}

/** The session a label's 8 characters name, among the sessions the host knows. */
export function sessionOf(
  short: string,
  sessions: readonly ExtensionSession[],
): ExtensionSession | null {
  return sessions.find((s) => s.id.startsWith(short)) ?? null;
}

export type CardDeps = {
  owner: string;
  enforce: boolean;
  sshKey: string | null;
  sessions: readonly ExtensionSession[];
  judged: ReadonlyMap<number, Judged>;
  hold: GpuHold;
  now: number;
  /** The session each claimed serverless endpoint is for, by endpoint id (`endpoints.ts`). */
  claims: ReadonlyMap<number, string>;
};

/**
 * The session a box is on: the one its label names, or, for a serverless
 * worker, the one that claimed its endpoint. Its 8 characters, or a full id.
 */
export function sessionKeyOf(
  box: Instance,
  owner: string,
  claims: ReadonlyMap<number, string>,
): string | null {
  const worker = workerOf(box.label ?? "");
  if (worker !== null) return claims.get(worker.endpointId) ?? null;
  return ownerOf(box, owner).session;
}

/** Whose a box is, from its label: its session (found among the host's), its owner. */
function whoseBox(
  box: Instance,
  deps: CardDeps,
): Pick<BoxCard, "name" | "session" | "owner" | "serverless"> {
  const { name, foreign } = ownerOf(box, deps.owner);
  const worker = workerOf(box.label ?? "");
  const session = sessionKeyOf(box, deps.owner, deps.claims);
  const known = session === null ? null : sessionOf(session, deps.sessions);
  const short = session?.slice(0, 8) ?? "";
  const labelled = parseLabel(box.label ?? "") !== null;
  const kind =
    foreign !== null ? "foreign" : labelled ? "mine" : worker !== null ? "serverless" : "none";
  return {
    name,
    session:
      session === null
        ? null
        : { short, id: known?.id ?? null, title: known?.title || `Session ${short}` },
    owner: { kind, name: foreign },
    serverless: worker,
  };
}

/** What the lease rules say of a box: its lease line, its spend of its budget. */
function leaseOf(
  judged: Judged | undefined,
  enforce: boolean,
): Pick<BoxCard, "lease" | "spent" | "budget" | "extendable"> {
  if (judged === undefined) return { lease: null, spent: null, budget: null, extendable: false };
  return {
    lease: leaseLine(judged, enforce),
    spent: judged.spent,
    budget: judged.budget,
    extendable: isManaged(judged),
  };
}

export function boxCard(box: Instance, deps: CardDeps): BoxCard {
  const who = whoseBox(box, deps);
  const state = stateOf(box);
  const target = sshTarget(box);
  const seconds = (at: number | null | undefined) => (at == null ? null : at * 1000);
  return {
    ...who,
    ...leaseOf(box.id === undefined ? undefined : deps.judged.get(box.id), deps.enforce),
    key: String(box.id ?? who.name),
    id: box.id ?? null,
    label: box.label ?? "",
    state,
    status: box.actual_status ?? box.intended_status ?? "?",
    rate: box.dph_total ?? 0,
    diskRate: box.storage_total_cost ?? null,
    diskGb: box.disk_space ?? null,
    gpu: box.gpu_name ?? "",
    gpus: box.num_gpus ?? 0,
    place: box.geolocation ?? "",
    load: state === "running" ? cardLoad(box, deps.hold, deps.now) : null,
    startedAt: seconds(box.start_date),
    endsAt: seconds(box.end_date),
    ssh: target === null ? null : sshCommand(target.host, target.port, deps.sshKey).join(" "),
  };
}

/** Running first, then starting, then the disks; each by name. */
export function boxCards(boxes: readonly Instance[], deps: CardDeps): BoxCard[] {
  const order: Record<BoxState, number> = { running: 0, starting: 1, disk: 2 };
  return boxes
    .map((box) => boxCard(box, deps))
    .sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
}

const RANK: Record<DecorationTone, number> = {
  critical: 4,
  warning: 3,
  info: 2,
  good: 1,
  muted: 0,
};

/**
 * The status bar's one item for the boxes: the panel's button, coloured by
 * the worst of what is only seen there (the boxes on no session of this
 * prifly), and amber for a disk still billing. Null when there is no box.
 */
export function panelItem(
  cards: readonly BoxCard[],
  folded: ReadonlyMap<string, DecorationTone>,
  panel: string,
): Decoration | null {
  if (cards.length === 0) return null;
  const running = cards.filter((c) => c.state !== "disk");
  const disks = cards.filter((c) => c.state === "disk");
  const burn =
    running.reduce((n, c) => n + c.rate, 0) + disks.reduce((n, c) => n + (c.diskRate ?? 0), 0);
  const tones: DecorationTone[] = [
    ...folded.values(),
    ...(disks.length > 0 ? ["warning" as const] : []),
  ];
  const tone = tones.reduce<DecorationTone>(
    (worst, t) => (RANK[t] > RANK[worst] ? t : worst),
    "info",
  );
  const counts = [
    running.length > 0 ? `${running.length} running` : "",
    disks.length > 0 ? `${disks.length} disk only` : "",
  ].filter((s) => s !== "");
  const outside = cards.filter((c) => folded.has(c.key));
  return {
    key: "fleet",
    icon: "server",
    label: `Vast.ai: ${counts.join(", ")} · $${burn.toFixed(2)}/h`,
    tone,
    details: [
      ...(disks.length > 0
        ? [`${disks.map((c) => c.name).join(", ")}: stopped, still billing disk until destroyed`]
        : []),
      ...(outside.length > 0
        ? [`On no session here: ${outside.map((c) => c.name).join(", ")}`]
        : []),
      "Open the panel for every box, its session and its actions.",
    ],
    panel,
  };
}
