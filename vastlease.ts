/**
 * `vastlease`: book, extend and cancel the lease on a Vast.ai box, from a session.
 *
 *   vastlease book <name> <hours>     before renting: the box labelled s-<session8>/<name>
 *   vastlease extend <box> <hours>    add hours (counted from now if the lease is over)
 *   vastlease cancel <box>            done with it: saved, then destroyed within a minute
 *   vastlease list                    every lease
 *
 * `<box>` is a name (this session's `s-<session8>/<name>`), a whole label, or
 * the Vast.ai instance id. prifly's Vast.ai extension destroys a session's box
 * that has no lease, or whose lease ended more than 15 minutes ago; see
 * `rules.ts`. The leases are the extension's `leases.json`, beside this file.
 */

import {
  book,
  cancel,
  extend,
  type Lease,
  type LeaseTarget,
  leasesPath,
  readLeases,
  updateLeases,
} from "./leases";
import { SESSION_LABEL, span } from "./rules";

const USAGE = `vastlease book <name> <hours>    book a box before renting it (label s-<session8>/<name>)
vastlease extend <box> <hours>   add hours to a box's lease
vastlease cancel <box>           end a lease now: the box is saved and destroyed
vastlease list                   every lease

<box> is a name, a label s-<session8>/<name>, or the Vast.ai instance id.`;

/** The extension's folder: this file's, even when run through the `bin` symlink. */
const FILE = leasesPath(import.meta.dir);

function labelOf(name: string): string {
  if (name.includes("/")) {
    if (!SESSION_LABEL.test(name)) throw new Error(`Not a session's label: ${name}`);
    return name;
  }
  const session = process.env["CLAUDE_CODE_SESSION_ID"]?.slice(0, 8);
  if (session === undefined || session.length < 8) {
    throw new Error("No CLAUDE_CODE_SESSION_ID: give the whole label, s-<session8>/<name>");
  }
  if (name.length > 8) throw new Error(`A box name is at most 8 characters: ${name}`);
  return `s-${session}/${name}`;
}

function targetOf(box: string): LeaseTarget {
  return /^\d+$/.test(box) ? { box: Number(box) } : { label: labelOf(box) };
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
  const [command, box, hours] = argv;
  const now = Date.now();
  switch (command) {
    case "book": {
      const lease = await updateLeases(FILE, (leases) =>
        book(leases, labelOf(box ?? ""), hoursOf(hours), now),
      );
      return `Booked: ${describe(lease, now)}\nRent it with --label "${lease.label}".`;
    }
    case "extend": {
      const target = targetOf(box ?? "");
      const lease = await updateLeases(FILE, (leases) => extendOnly(leases, target, hours, now));
      return `Extended: ${describe(lease, now)}`;
    }
    case "cancel": {
      const lease = await updateLeases(FILE, (leases) => cancel(leases, targetOf(box ?? "")));
      return lease.box === null
        ? `Dropped the booking for ${lease.label}.`
        : `Cancelled: ${lease.label} (#${lease.box}) is saved and destroyed within a minute.`;
    }
    case "list": {
      const leases = await readLeases(FILE);
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

try {
  console.log(await main(Bun.argv.slice(2)));
} catch (caught) {
  console.error(`vastlease: ${caught instanceof Error ? caught.message : String(caught)}`);
  process.exit(1);
}
