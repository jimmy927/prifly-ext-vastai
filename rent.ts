/**
 * `vast_rent`: rent a box only after the reader has seen the price and set the
 * budget.
 *
 * The session proposes offers (best first) and a budget. Each offer is fetched
 * again for today's price, and the ones that are gone, or that could not run
 * an hour within the budget, or whose host end date comes before the budget's
 * runtime (held to 24 hours) plus an hour's margin, are left off. What is left goes on prifly's pick
 * card with the budget as an editable amount; nothing is booked or created
 * before the reader answers. The lease is booked with the amount the reader
 * CONFIRMED, not the one suggested, and its end is held to the hour that budget
 * runs out (and to 24 hours). If the chosen offer is gone by then, the next
 * card rows that still fit the confirmed budget are tried in card order.
 */

import { z } from "zod";
import { cpuScores } from "./cpu-score";
import { ACK_TEXT, runwayHours } from "./credit";
import { book, dropBooking, MAX_AHEAD_MS, type Replace, setReplace, updateLeases } from "./leases";
import { endsTooSoon, fetchOffer, type Offer, perfCells, timeLeft } from "./offers";
import type { ExtensionPick, ExtensionTool, ExtensionToolContext, RentUi } from "./prifly-api";
import { type CellInput, columnsFor, NEEDS } from "./rent-columns";
import { sessionLabel } from "./rules";
import { budgetText, dollars } from "./spend";
import {
  type CreditGuard,
  confirmOver,
  creditGuard,
  creditNow,
  defineTool,
  endText,
  guardedAmount,
  HOUR_MS,
  hasCells,
  hasLimit,
  hasLinks,
  NAME,
  rateCell,
  sshText,
  type ToolDeps,
} from "./tool-kit";
import { type CreateRequest, createInstance, listInstances, OfferGone, withKeys } from "./vast-api";

const PORT = /^\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/;

/** An Ollama model name such as `llama3.2:3b` or `hf.co/<user>/<repo>:Q4_K_M`: no quote, space, `$` or leading dash can get through. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,199}$/;
const OLLAMA_PORT = 11434;
export const OLLAMA_IMAGE = "ollama/ollama";
export const OLLAMA_CONTEXT_DEFAULT = 65536;

const OllamaArgs = z.strictObject({
  models: z
    .array(z.string().regex(MODEL, "not an Ollama model name (letters, digits, . _ - / : @)"))
    .min(1)
    .max(8)
    .describe('Models to pull, e.g. "qwen2.5-coder:7b" or "hf.co/<user>/<repo>:Q4_K_M".'),
  context_length: z
    .number()
    .int()
    .min(512)
    .max(1048576)
    .optional()
    .describe(`OLLAMA_CONTEXT_LENGTH, default ${OLLAMA_CONTEXT_DEFAULT}.`),
});
type OllamaOptions = z.infer<typeof OllamaArgs>;

const RentArgs = z.strictObject({
  name: z
    .string()
    .regex(NAME)
    .describe(
      "The box's name: at most 8 characters, letters, digits, - and _. It is the box's label's last part.",
    ),
  budget: z
    .number()
    .positive()
    .describe(
      "Your suggested budget in dollars for the whole rental. The reader sees it on the card and may change it; the confirmed amount is the box's limit: with lease enforcement on (the default) it is saved and destroyed when it has cost this much.",
    ),
  offers: z
    .array(z.number().int().positive())
    .min(1)
    .max(12)
    .describe(
      "Offer ids (ask_contract_id from vast_offers), best first. If the chosen one is gone, the next that fits the budget is rented.",
    ),
  image: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Docker image, e.g. ubuntu:22.04. Required, except with ollama, where it defaults to ollama/ollama.",
    ),
  disk_gb: z.number().positive().describe("Disk in GB. It is billed, so it is in the rate."),
  onstart: z
    .string()
    .optional()
    .describe(
      "Shell commands to run on start. Default: sleep infinity, so a bare image stays up. Not with ollama, which writes the onstart itself.",
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables, name to value."),
  ports: z
    .array(z.string().regex(PORT))
    .optional()
    .describe('Ports to open, e.g. "8080:8080/tcp".'),
  ollama: OllamaArgs.optional().describe(
    "Serve Ollama for prifly's model providers, in one choice: the image defaults to ollama/ollama, the onstart starts `ollama serve` on the box's own 127.0.0.1:11434 and pulls the models, and port 11434 is never opened. prifly reaches it through `ssh -L <port>:127.0.0.1:11434`. Do not pass onstart, or a port 11434, with it.",
  ),
  purpose: z
    .string()
    .min(1)
    .describe(
      "What the box is for and why this budget: it is shown on the card, in the reader's words, as the reason for the suggestion.",
    ),
  need: z
    .enum(NEEDS)
    .describe(
      'What the work is bound by, which decides the columns on the card. "gpu": the work runs on the GPU (training, inference); the card shows every column. "cpu": CPU-bound work (compiles, embeddings on the CPU, data crunching); the card drops the GPU columns and keeps CPU performance. "io": it waits on the network or remote APIs, so the cheapest reliable box wins; the card drops the GPU and CPU performance columns.',
    ),
  need_note: z
    .string()
    .min(1)
    .describe(
      'One line saying concretely what the job needs, shown on the card as "Needs: ...", e.g. "1-2 threads, no GPU: waits on Gemini".',
    ),
});
export type RentArgs = z.infer<typeof RentArgs>;

const DESCRIPTION =
  'Rent a Vast.ai box. Shows the reader the offers on a card with an editable budget, and what of it the account\'s credit covers after everything already running on the account, and waits for their answer; only then is a lease booked and the box created. A budget over what the credit covers needs the reader\'s word that they will top up. Offers that are gone, could not run an hour within the budget, or end (host end date) before the budget runs out plus an hour, are left off. If the chosen offer is gone, the next card row that fits the budget is rented. With lease enforcement on (the default), if the box later turns out broken (ssh refused for 3 minutes, a log showing bad ownership or modes, or stuck in created or loading for 10 minutes), the plugin cancels it and rents the next card row that fits what is left of the confirmed budget by itself, at most 3 times, with no new card. Returns the box\'s id, label, rate, budget, lease end and ssh command. Pass need ("gpu", "cpu" or "io") and need_note so the card shows what the job needs and only the columns that matter. With ollama (models, optional context_length) the box serves Ollama for prifly\'s model providers: no image or onstart needed, and 11434 is never opened (prifly tunnels over ssh). Use vast_offers first to find offer ids. Never rent any other way.';

/**
 * Run first in every box's onstart so sshd's "bad ownership or modes" check can
 * never lock us out (VAI-35), and so Vast's login wrapper does not put every
 * ssh session in tmux: without `/root/.no_auto_tmux` a non-interactive
 * `ssh host cmd` prints "open terminal failed: not a terminal" and runs
 * nothing (VAI-49). Errors are dropped and `|| true` keeps `set -e`
 * from ending the script. No `pkill`/HUP: it kills sshd on images that run it
 * in the foreground (VAI-38).
 */
export const SSH_KEY_REPAIR =
  '{ touch /root/.no_auto_tmux; chmod go-w /root; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; sed -i "s/^#*[[:space:]]*StrictModes.*/StrictModes no/" /etc/ssh/sshd_config; } 2>/dev/null || true';

/** `'...'` for the shell, whatever the text holds. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The onstart that serves Ollama on the box's own loopback: the server in the
 * background (its log in /var/log/ollama.log), a wait until the API answers,
 * each model pulled, then the box kept up. Vast's ssh launch mode replaces the
 * image's `ollama` entrypoint and runs this, so `ollama serve` is started here.
 * 11434 is bound to 127.0.0.1 and never mapped: prifly tunnels to it over ssh.
 */
export function ollamaScript({ models, context_length }: OllamaOptions): string {
  const context = context_length ?? OLLAMA_CONTEXT_DEFAULT;
  return [
    `export OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} OLLAMA_CONTEXT_LENGTH=${context} OLLAMA_KEEP_ALIVE=-1`,
    "nohup ollama serve >>/var/log/ollama.log 2>&1 &",
    "SERVE_PID=$!",
    "for _ in $(seq 1 150); do ollama list >/dev/null 2>&1 && break; sleep 2; done",
    // So that `ssh box curl 127.0.0.1:11434/api/tags` works; the image may not ship curl.
    "command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; } >>/var/log/ollama.log 2>&1 || true",
    ...models.map(
      (model) =>
        `ollama pull ${quoted(model)} >>/var/log/ollama-pull.log 2>&1 || echo ${quoted(`pull failed: ${model}`)} >>/var/log/ollama-pull.log`,
    ),
    'wait "$SERVE_PID"',
    "sleep infinity",
  ].join("\n");
}

/** What the create request carries for the args: image, onstart, env. A throw says what conflicts. */
export function launchOf(args: RentArgs): {
  image: string;
  onstart: string;
  env: Record<string, string>;
} {
  const ports = args.ports ?? [];
  const ollama = args.ollama;
  if (ollama !== undefined) {
    if (args.onstart !== undefined) {
      throw new Error("ollama writes the onstart itself: pass either ollama or onstart, not both");
    }
    if (ports.some((port) => port.split(/[:/]/).includes(String(OLLAMA_PORT)))) {
      throw new Error(`Port ${OLLAMA_PORT} is never opened: prifly reaches Ollama through ssh -L`);
    }
  } else if (args.image === undefined) {
    throw new Error("image is required unless ollama is given");
  }
  return {
    image: args.image ?? OLLAMA_IMAGE,
    onstart: withSshRepair(ollama === undefined ? args.onstart : ollamaScript(ollama)),
    env: {
      ...(args.env ?? {}),
      ...Object.fromEntries(ports.map((port) => [`-p ${port}`, "1"])),
      ...(ollama === undefined
        ? {}
        : {
            OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
            OLLAMA_CONTEXT_LENGTH: String(ollama.context_length ?? OLLAMA_CONTEXT_DEFAULT),
            OLLAMA_KEEP_ALIVE: "-1",
          }),
    },
  };
}

/** The purpose as the card shows it: a model provider says so first. */
function purposeOf(args: RentArgs, max: number): string {
  const own = args.purpose.trim().slice(0, max);
  return args.ollama === undefined
    ? own
    : `Ollama model provider: ${args.ollama.models.join(", ")}. ${own}`;
}

/** The repair, then the caller's onstart (or `sleep infinity`, which keeps the box up). */
export function withSshRepair(onstart?: string): string {
  return `${SSH_KEY_REPAIR}\n${onstart ?? "sleep infinity"}`;
}

export function rentTool(deps: ToolDeps): ExtensionTool {
  return defineTool("vast_rent", DESCRIPTION, RentArgs, (args, ctx) => rent(deps, args, ctx));
}

/** The hint under the amount field: the session's reason for the suggestion. */
function hintOf(purpose: string, enforce: boolean): string {
  const reason = purpose.replace(/[.\s]+$/, "").slice(0, 240);
  const ends = enforce
    ? "The box is saved and destroyed when it has cost this much."
    : "Lease enforcement is off, so nothing destroys the box at this amount: it bills until vast_cancel ends it.";
  return `Suggested by Claude: ${reason}. ${ends}`;
}

/** Hours the box is meant to run: what the budget buys, held to the longest lease. */
export function runHours(offer: Offer, budget: number): number {
  return Math.min(MAX_AHEAD_MS / HOUR_MS, budget / offer.dph_total);
}

/** Today's offers for the ids, in the session's order, without those gone, too dear for an hour or ending before the budget runs out. */
async function cardOffers(deps: ToolDeps, args: RentArgs): Promise<Offer[]> {
  const ids = [...new Set(args.offers)];
  const found = await Promise.all(ids.map((id) => fetchOffer(id, args.disk_gb, deps.get)));
  return found.flatMap((offer) =>
    offer !== null &&
    offer.dph_total <= args.budget &&
    !endsTooSoon(offer, runHours(offer, args.budget), deps.now())
      ? [offer]
      : [],
  );
}

async function cardOf(
  deps: ToolDeps,
  args: RentArgs,
  offers: readonly Offer[],
  guard: CreditGuard,
): Promise<ExtensionPick> {
  const now = deps.now();
  const cpus = await cpuScores(deps.get, now);
  const links = hasLinks(deps);
  const cells = hasCells(deps);
  const columns = columnsFor(args.need);
  // One cell per offer and chosen column: rows, links, titles and kinds cannot drift apart.
  const built = offers.map((offer) => {
    const input: CellInput = {
      offer,
      budget: args.budget,
      now,
      cpus,
      perf: perfCells(offer, cpus),
      flags: cells,
      offerLink: links,
    };
    return columns.map((column) => column.cell(input));
  });
  return {
    title: `Rent ${args.name}: ${purposeOf(args, 120)}. Needs: ${args.need_note.trim().slice(0, 120)}. If the box you pick is gone, the next row that fits the budget is rented.`,
    columns: columns.map((column) => column.name),
    rows: built.map((row) => row.map((cell) => cell.text)),
    ...(links ? { links: built.map((row) => row.map((cell) => cell.link ?? null)) } : {}),
    ...(cells
      ? {
          titles: built.map((row) => row.map((cell) => cell.title ?? null)),
          cellKinds: built.map((row) => row.map((cell) => cell.kind ?? null)),
        }
      : {}),
    action: "Rent",
    amount: {
      label: "Budget for this rental",
      prefix: "$",
      value: args.budget,
      perRow: { column: "Hours", rateColumn: "$/h", unit: "h" },
      ...guardedAmount(deps, hintOf(purposeOf(args, 240), deps.enforce), guard),
    },
  };
}

/** What the reader's card came to: a box (its id and the tool's text), no choice, or no top-up. */
export type Outcome =
  | { kind: "rented"; id: number; text: string }
  | { kind: "none" }
  | { kind: "declined" };

async function rent(deps: ToolDeps, args: RentArgs, ctx: ExtensionToolContext): Promise<string> {
  const outcome = await rentOnCard(deps, args, ctx.session, ctx);
  if (outcome.kind === "none") {
    return "The reader chose none of the offers. Nothing was rented and nothing is booked. Ask what to change, then search again.";
  }
  if (outcome.kind === "declined") {
    return "The reader did not rent past what the Vast credit covers. Nothing was rented and nothing is booked.";
  }
  return outcome.text;
}

/**
 * The rental both entry points share, the `vast_rent` tool and the New session
 * dialog's rent row: check the label is free, look the offers up, show the
 * card over `session`, and create the box with what the reader confirmed. A
 * throw says why nothing was rented.
 */
export async function rentOnCard(
  deps: ToolDeps,
  args: RentArgs,
  session: string,
  ui: RentUi,
): Promise<Outcome> {
  launchOf(args); // a conflict throws before anything is looked up
  const label = sessionLabel(await deps.owner(), session, args.name);
  const keys = await deps.keys();
  // A second box under one label would hold no lease of its own and be destroyed.
  const taken = (await listInstances(keys, deps.get)).some((box) => box.label === label);
  if (taken)
    throw new Error(`This session already has a box named ${args.name}: pick another name`);
  const offers = await cardOffers(deps, args);
  if (offers.length === 0) {
    throw new Error(
      `None of the offers can be rented for the budget of ${budgetText(args.budget)} (each is gone, costs more than that per hour, or ends before the budget runs out). Nothing was booked. Search again with vast_offers.`,
    );
  }
  // The dearest row's rate: the limit then holds whichever row the reader picks.
  const dearest = Math.max(...offers.map((offer) => offer.dph_total));
  const guard = creditGuard(deps, await creditNow(deps, { label }), dearest, ACK_TEXT);
  const answer = await ui.pick(await cardOf(deps, args, offers, guard));
  if (answer === null) return { kind: "none" };
  const budget = answer.amount;
  if (budget === null || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("The reader's answer carried no budget, so nothing was rented.");
  }
  const chosen = offers[answer.row];
  if (chosen === undefined)
    throw new Error(`The reader's answer names row ${answer.row}, which is not on the card.`);
  const order = [chosen, ...offers.filter((offer) => offer !== chosen)];
  const short = await shortfall(deps, ui, { label, budget, rate: chosen.dph_total });
  if (short === "declined") return { kind: "declined" };
  const made = await createFirst(deps, { args, label, budget, order, session, short });
  return { kind: "rented", ...made };
}

/** What the confirmed budget is over the credit, read again now: null when it fits or the credit is unknown. */
type Short = { over: number; max: number; until: number } | null;

/**
 * Check the confirmed budget against the credit once more. Past it, prifly's
 * card has already had the reader tick "I will top up"; an older prifly's card
 * could not, so they are asked on a second one.
 */
async function shortfall(
  deps: ToolDeps,
  ui: RentUi,
  { label, budget, rate }: { label: string; budget: number; rate: number },
): Promise<Short | "declined"> {
  const credit = await creditNow(deps, { label });
  const limit = creditGuard(deps, credit, rate, ACK_TEXT).limit;
  if (credit === null || limit === undefined || budget <= limit.max) return null;
  const { account, committed } = credit;
  const until = deps.now() + runwayHours(account, committed.burn + rate) * HOUR_MS;
  const short = { over: budget - limit.max, max: limit.max, until };
  deps.log("rent_over_credit", { label, budget, max: limit.max, credit: account.credit });
  if (hasLimit(deps)) return short;
  return (await confirmOver(ui, { what: "Rent", amount: budget, limit })) ? short : "declined";
}

type Attempt = {
  args: RentArgs;
  label: string;
  budget: number;
  order: Offer[];
  session: string;
  short: Short;
};

/** Try the offers in order with the confirmed budget; the booking is dropped unless a box was created. */
async function createFirst(
  deps: ToolDeps,
  attempt: Attempt,
): Promise<{ id: number; text: string }> {
  const failures: string[] = [];
  let created = false;
  try {
    for (const [index, offer] of attempt.order.entries()) {
      const box = await tryOffer(deps, attempt, offer, index === 0, failures);
      if (box !== null) {
        created = true;
        await keepReplacements(deps, attempt, { offer, index, box });
        return { id: box.id, text: await describe(deps, attempt, offer, box) };
      }
    }
  } finally {
    if (!created) await updateLeases(deps.store, (leases) => dropBooking(leases, attempt.label));
  }
  throw new Error(
    `No box was rented and the booking is dropped: ${failures.join("; ")}. The reader's budget was ${budgetText(attempt.budget)}.`,
  );
}

/**
 * Keep with the new box's lease what replaces it if it turns out broken: the
 * rest of the card, what the box was created with, and the budget the reader
 * confirmed. `enforce.ts` rents the replacement from it, with no new card.
 */
async function keepReplacements(
  deps: ToolDeps,
  { label, budget, order }: Attempt,
  {
    offer,
    index,
    box,
  }: { offer: Offer; index: number; box: { id: number; request: CreateRequest } },
): Promise<void> {
  const replace: Replace = {
    offers: order.slice(index + 1).map((o) => o.ask_contract_id),
    excluded: [],
    confirmed: budget,
    spent: 0,
    count: 0,
    request: box.request,
    machine: offer.machine_id ?? null,
    replaces: null,
  };
  await updateLeases(deps.store, (leases) => setReplace(leases, { box: box.id, label }, replace));
}

/** Why the offer cannot be rented for the confirmed budget, or null when it can. */
export function refusalOf(offer: Offer, budget: number, hours: number, now: number): string | null {
  const id = offer.ask_contract_id;
  if (offer.dph_total > budget) {
    return `offer ${id} costs ${rateCell(offer.dph_total)} per hour, more than the confirmed budget`;
  }
  if (endsTooSoon(offer, hours, now)) {
    return `offer ${id} ends in ${timeLeft(offer, now)}, before the ${hours.toFixed(1)} h the budget runs plus an hour's margin`;
  }
  return null;
}

/** Look at the offer again, book the lease and create the box; the box and its lease end, or null with the reason noted. */
async function tryOffer(
  deps: ToolDeps,
  { args, label, budget }: Attempt,
  offer: Offer,
  chosen: boolean,
  failures: string[],
): Promise<{ id: number; until: number; request: CreateRequest } | null> {
  const id = offer.ask_contract_id;
  const fresh = await fetchOffer(id, args.disk_gb, deps.get);
  if (fresh === null) {
    failures.push(`offer ${id} is gone`);
    return null;
  }
  const now = deps.now();
  const hours = runHours(fresh, budget);
  const refusal = refusalOf(fresh, budget, hours, now);
  if (refusal !== null) {
    failures.push(refusal);
    // The reader chose this one: another box in its place would not be what they approved.
    if (chosen) throw new Error(failures.join("; "));
    return null;
  }
  await updateLeases(deps.store, (leases) => book(leases, label, hours, now, budget));
  const until = now + hours * HOUR_MS;
  const request = { ...launchOf(args), disk: args.disk_gb, label };
  try {
    const box = await withKeys(await deps.keys(), (key) =>
      createInstance(key, id, request, deps.get),
    );
    deps.log("rented", { offer: id, instance: box, label, budget, until, rate: fresh.dph_total });
    return { id: box, until, request };
  } catch (caught) {
    if (caught instanceof OfferGone) {
      failures.push(caught.message);
      return null;
    }
    // Offline or a server error: whether a box exists is unknown, so look for it.
    const message = caught instanceof Error ? caught.message : String(caught);
    const existing = (await listInstances(await deps.keys(), deps.get)).find(
      (box) => box.label === label,
    );
    if (existing?.id !== undefined) return { id: existing.id, until, request };
    failures.push(message);
    return null;
  }
}

async function describe(
  deps: ToolDeps,
  { args, label, budget, short }: Attempt,
  offer: Offer,
  { id, until }: { id: number; until: number },
): Promise<string> {
  const listed = (await listInstances(await deps.keys(), deps.get)).find((box) => box.id === id);
  const ssh = listed === undefined ? null : sshText(listed, deps.sshKey);
  deps.refresh();
  return [
    `Rented ${args.name}: Vast.ai #${id}, label ${label}.`,
    `Rate: ${dollars(offer.dph_total)}/h. Budget: ${budgetText(budget)}, the reader's confirmed amount${deps.enforce ? ": the box is saved and destroyed when it has cost that much" : ". Lease enforcement is off, so nothing destroys the box at that amount: it bills until vast_cancel ends it"}.`,
    `Lease until ${endText(until, deps.now())}; vast_extend adds time. vast_cancel ends it.`,
    ...(short === null
      ? []
      : [
          `The budget is ${dollars(short.over)} more than the Vast credit covers (${budgetText(short.max)}); the reader said they will top up. At the account's burn the credit runs out about ${endText(short.until, deps.now())}: remind them to top up at console.vast.ai → Billing before then, or Vast stops every box on the account.`,
        ]),
    ssh === null
      ? "ssh: no address yet; vast_boxes shows it once the box is running."
      : `ssh: ${ssh} (works once the box is running)`,
  ].join("\n");
}
