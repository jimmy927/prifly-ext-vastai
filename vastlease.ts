/**
 * `vastlease`: book, extend and cancel the lease on a Vast.ai box, from a session.
 *
 *   vastlease book <name> <hours>     before renting: prints the --label to rent with
 *   vastlease extend <box> <hours>    add hours (counted from now if the lease is over)
 *   vastlease cancel <box>            done with it: saved, then destroyed within a minute
 *   vastlease list                    every lease
 *
 * A box is labelled `<owner>/s-<session8>/<name>`; the owner is read as the
 * extension reads it (`owner.ts`: `config.json` beside this file, else
 * `$USER`). `<box>` is a name (this session's box), a whole label — the new
 * form or the older `s-<session8>/<name>` — or the Vast.ai instance id. A name
 * finds a lease under either form, the new one first. prifly's Vast.ai
 * extension destroys a session's box that has no lease, or whose lease ended
 * more than 15 minutes ago; see `rules.ts`. The leases are the extension's
 * `leases.json`, beside this file.
 */

import {
  book,
  cancel,
  extend,
  find,
  type Lease,
  type LeaseTarget,
  leasesPath,
  readLeases,
  updateLeases,
} from "./leases";
import { readOwner } from "./owner";
import { parseLabel, sessionLabel, span } from "./rules";

const USAGE = `vastlease book <name> <hours>    book a box before renting it; prints the --label to rent with
vastlease extend <box> <hours>   add hours to a box's lease
vastlease cancel <box>           end a lease now: the box is saved and destroyed
vastlease list                   every lease

<box> is a name, a label <owner>/s-<session8>/<name> (or the older s-<session8>/<name>),
or the Vast.ai instance id.`;

/** The longest box name, so short displays show it whole. */
const NAME_MAX = 8;

/** Who is asking: this prifly's owner and the session's first 8 characters, if it has an id. */
export type Asker = { owner: string; session8: string | undefined };

/**
 * The labels `box` may mean, the likeliest first: a whole label as given, or
 * for a name this session's label in the new form, then in the older one.
 */
export function labelsFor(box: string, asker: Asker): string[] {
  if (box.includes("/")) {
    const parsed = parseLabel(box);
    if (parsed === null) throw new Error(`Not a session's label: ${box}`);
    if (parsed.owner !== null && parsed.owner !== asker.owner) {
      throw new Error(`${box} is ${parsed.owner}'s box, not ${asker.owner}'s`);
    }
    return [box];
  }
  const session = asker.session8;
  if (session === undefined || !/^[0-9a-f]{8}$/.test(session)) {
    throw new Error(
      `No CLAUDE_CODE_SESSION_ID: give the whole label, ${asker.owner}/s-<session8>/<name>`,
    );
  }
  if (box === "" || box.length > NAME_MAX) {
    throw new Error(`A box name is 1 to ${NAME_MAX} characters: ${box || "(none given)"}`);
  }
  return [sessionLabel(asker.owner, session, box), `s-${session}/${box}`];
}

/** The label `book` books: the likeliest one, with a name no longer than `NAME_MAX`. */
export function bookingLabel(box: string, asker: Asker): string {
  const label = labelsFor(box, asker)[0] ?? box;
  const name = parseLabel(label)?.name ?? "";
  if (name.length > NAME_MAX) {
    throw new Error(`A box name is at most ${NAME_MAX} characters: ${name}`);
  }
  return label;
}

/** Which lease a command means: the id, or the first of its labels that has a lease. */
export function targetOf(leases: readonly Lease[], box: string, asker: Asker): LeaseTarget {
  if (/^\d+$/.test(box)) return { box: Number(box) };
  const labels = labelsFor(box, asker).map((label) => ({ label }));
  return labels.find((target) => find(leases, target) !== null) ?? labels[0] ?? { label: box };
}

function hoursOf(text: string | undefined): number {
  const hours = Number(text);
  if (text === undefined || !Number.isFinite(hours) || hours <= 0) {
    throw new Error(`How many hours? ${text ?? "(none given)"}`);
  }
  return hours;
}

function describe(lease: Lease, now: number): string {
  const box = lease.box === null ? "not rented yet" : `#${lease.box}`;
  const when = new Date(lease.until).toLocaleString();
  if (lease.cancelled) return `${lease.label} (${box}): cancelled, being destroyed`;
  const left = lease.until - now;
  return `${lease.label} (${box}): until ${when} (${left > 0 ? `${span(left)} left` : "over"})`;
}

async function main(argv: string[]): Promise<string> {
  const [command, box = "", hours] = argv;
  const now = Date.now();
  const folder = import.meta.dir;
  const file = leasesPath(folder);
  const asker = async (): Promise<Asker> => ({
    owner: await readOwner(folder, process.env),
    session8: process.env["CLAUDE_CODE_SESSION_ID"]?.slice(0, 8),
  });
  switch (command) {
    case "book": {
      const label = bookingLabel(box, await asker());
      const lease = await updateLeases(file, (leases) => book(leases, label, hoursOf(hours), now));
      return `Booked: ${describe(lease, now)}\nRent it with exactly this label: --label "${lease.label}"`;
    }
    case "extend": {
      const who = await asker();
      const lease = await updateLeases(file, (leases) =>
        extendOnly(leases, targetOf(leases, box, who), hours, now),
      );
      return `Extended: ${describe(lease, now)}`;
    }
    case "cancel": {
      const who = await asker();
      const lease = await updateLeases(file, (leases) =>
        cancel(leases, targetOf(leases, box, who)),
      );
      return lease.box === null
        ? `Dropped the booking for ${lease.label}.`
        : `Cancelled: ${lease.label} (#${lease.box}) is saved and destroyed within a minute.`;
    }
    case "list": {
      const leases = await readLeases(file);
      return leases.length === 0 ? "No leases." : leases.map((l) => describe(l, now)).join("\n");
    }
    default:
      return USAGE;
  }
}

/** `extend` from a session never adopts a box without a lease: booking one is `book`'s. */
function extendOnly(leases: Lease[], target: LeaseTarget, hours: string | undefined, now: number) {
  return extend(leases, target, hoursOf(hours), now);
}

if (import.meta.main) {
  try {
    console.log(await main(Bun.argv.slice(2)));
  } catch (caught) {
    console.error(`vastlease: ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exit(1);
  }
}
