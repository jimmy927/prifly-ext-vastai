import { describe, expect, test } from "bun:test";
import { readLeases } from "../leases";
import type { ExtensionSession, ExtensionToolContext } from "../prifly-api";
import { fileStore } from "../store";
import { offer, setup, vast } from "./fake-vast";

const PARENT = "aaaa1111-0000-0000-0000-000000000001";
const CHILD = "bbbb2222-0000-0000-0000-000000000002";
const SIBLING = "cccc3333-0000-0000-0000-000000000003";
const OTHER = "dddd4444-0000-0000-0000-000000000004";

const session = (id: string, title: string, parentId?: string): ExtensionSession => ({
  id,
  title,
  cwd: "/w",
  state: "idle",
  ...(parentId === undefined ? {} : { parentId }),
});
const SESSIONS = [
  session(PARENT, "Parent job"),
  session(CHILD, "Child job", PARENT),
  session(SIBLING, "Sibling job", PARENT),
  session(OTHER, "Unrelated job"),
];

const RENT = {
  name: "accent",
  budget: 20,
  offers: [101],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "the same job",
};

/** A session's context whose card waits for `release`, and answers the first row at $20. */
function ctxOf(id: string, wait?: Promise<void>) {
  const cards: unknown[] = [];
  const ctx: ExtensionToolContext = {
    session: id,
    signal: new AbortController().signal,
    pick: async (card) => {
      cards.push(card);
      await wait;
      return { row: 0, amount: 20 };
    },
  };
  return { ctx, cards };
}

async function world(sessions: ExtensionSession[] = SESSIONS) {
  const fake = vast([offer(101, 0.5)]);
  const { tool, store, folder } = await setup(fake, [], fileStore, () => sessions);
  return { fake, rent: tool("vast_rent"), store, folder };
}

describe("vast_rent and the session's family", () => {
  test("a child is refused while its parent's card is open, and the parent still rents", async () => {
    const { fake, rent, store } = await world();
    let release = () => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parent = ctxOf(PARENT, open);
    const renting = rent.call(RENT, parent.ctx);
    await Bun.sleep(20);
    expect(parent.cards).toHaveLength(1);
    const child = ctxOf(CHILD);
    const text = await rent.call({ ...RENT, name: "Accent" }, child.ctx);
    expect(text).toContain("Parent job");
    expect(text).toContain("`aaaa1111`");
    expect(text).toContain("(pending)");
    expect(child.cards).toEqual([]);
    expect(fake.puts).toEqual([]);
    expect(await readLeases(store)).toEqual([]);
    release();
    expect(await renting).toContain("Rented accent");
  });

  test("a child is refused while its parent has a running box of that name", async () => {
    const { fake, rent } = await world();
    await rent.call(RENT, ctxOf(PARENT).ctx);
    expect(fake.puts).toHaveLength(1);
    const child = ctxOf(CHILD);
    const text = await rent.call(RENT, child.ctx);
    expect(text).toBe(
      'Not rented: Parent job (`aaaa1111`) already has the box "accent" (running) for this — message that session to coordinate, or rent under another name if the work really differs.',
    );
    expect(child.cards).toEqual([]);
    expect(fake.puts).toHaveLength(1);
  });

  test("a parent is refused by its child's box, and a sibling by a sibling's", async () => {
    const { rent } = await world();
    await rent.call(RENT, ctxOf(CHILD).ctx);
    expect(await rent.call(RENT, ctxOf(PARENT).ctx)).toContain("Child job");
    expect(await rent.call(RENT, ctxOf(SIBLING).ctx)).toContain("`bbbb2222`");
  });

  test("an unrelated session, another name and the session itself are not refused", async () => {
    const { fake, rent } = await world();
    await rent.call(RENT, ctxOf(PARENT).ctx);
    expect(await rent.call(RENT, ctxOf(OTHER).ctx)).toContain("Rented accent");
    expect(await rent.call({ ...RENT, name: "other" }, ctxOf(CHILD).ctx)).toContain("Rented other");
    await expect(rent.call(RENT, ctxOf(PARENT).ctx)).rejects.toThrow("already has a box named");
    expect(fake.puts).toHaveLength(3);
  });

  test("with no parent ids at all (an older prifly) nothing is refused", async () => {
    const { rent } = await world(SESSIONS.map(({ parentId: _, ...rest }) => rest));
    await rent.call(RENT, ctxOf(PARENT).ctx);
    expect(await rent.call(RENT, ctxOf(CHILD).ctx)).toContain("Rented accent");
  });

  test("a refused or answered card leaves nothing pending", async () => {
    const { rent } = await world();
    const none = { ...ctxOf(PARENT).ctx, pick: async () => null };
    expect(await rent.call(RENT, none)).toContain("chose none");
    expect(await rent.call(RENT, ctxOf(CHILD).ctx)).toContain("Rented accent");
  });
});
