/**
 * The sessions that share a job: a session, the one that started it, the ones
 * it started and its siblings. `vast_rent` refuses a name one of them already
 * has a box (or an open rent) under, so a parent and its child cannot both put
 * a card in front of the reader for the same work.
 */

import type { ExtensionSession } from "./prifly-api";
import { parseLabel } from "./rules";
import type { ToolDeps } from "./tool-kit";
import type { Instance } from "./vast-api";

/** A rent in progress: the session's card is open, or its create is in flight. `name` is lower-case. */
export type Pending = { session: string; name: string };

/**
 * The sessions that started this one, were started by it, or were started by
 * the same one. Without `parentId` (a prifly without "session-facts") there are none.
 */
export function familyOf(
  sessions: readonly ExtensionSession[],
  session: string,
): ExtensionSession[] {
  const parent = sessions.find((s) => s.id === session)?.parentId;
  return sessions.filter(
    (s) =>
      s.id !== session &&
      (s.parentId === session ||
        (parent !== undefined && (s.id === parent || s.parentId === parent))),
  );
}

/**
 * The rents in progress per set of tools: a card open or a create in flight.
 * Keyed by the deps object, which the tool and the New session dialog share.
 */
const PENDING = new WeakMap<ToolDeps, Set<Pending>>();

/**
 * Hold `name` for `session` while it rents, unless a family member already
 * holds or is renting a box of that name: then the refusal. The hold is
 * released by calling what this returns. Synchronous, so two rents cannot
 * both pass the check.
 */
export function holdName(
  deps: ToolDeps,
  boxes: readonly Instance[],
  wanted: { session: string; name: string; owner: string },
): string | (() => void) {
  const pending = PENDING.get(deps) ?? new Set<Pending>();
  PENDING.set(deps, pending);
  const refused = familyRefusal(deps, pending, boxes, wanted);
  if (refused !== null) return refused;
  const mine = { session: wanted.session, name: wanted.name.toLowerCase() };
  pending.add(mine);
  return () => pending.delete(mine);
}

/** The refusal when a family member already holds or is renting a box of this name, else null. */
export function familyRefusal(
  deps: ToolDeps,
  pending: ReadonlySet<Pending>,
  boxes: readonly Instance[],
  { session, name, owner }: { session: string; name: string; owner: string },
): string | null {
  const wanted = name.toLowerCase();
  for (const member of familyOf(deps.sessions(), session)) {
    const open = [...pending].some((p) => p.session === member.id && p.name === wanted);
    const box = boxes.find((b) => {
      const parsed = parseLabel(b.label ?? "");
      return (
        parsed !== null &&
        member.id.startsWith(parsed.session) &&
        (parsed.owner === null || parsed.owner === owner) &&
        parsed.name.toLowerCase() === wanted
      );
    });
    if (!open && box === undefined) continue;
    const state = open ? "pending" : box?.actual_status || "running";
    return `Not rented: ${member.title} (\`${member.id.slice(0, 8)}\`) already has the box "${name}" (${state}) for this — message that session to coordinate, or rent under another name if the work really differs.`;
  }
  return null;
}
