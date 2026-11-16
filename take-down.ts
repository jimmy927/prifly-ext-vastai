/** The end of a take-down (`enforce.ts`): how it came out, and the wait until Vast.ai's list no longer has the box. */

import type { Pulled } from "./campaign";

/**
 * How a take-down ended. `destroyed`: the box is no longer on Vast.ai's list.
 * `kept`: it was not destroyed, because the lease was extended meanwhile or the
 * extension stopped. `failed`: the box may still be running and billing; `why`
 * says what Vast.ai answered.
 */
export type TakeDown =
  | { kind: "destroyed"; hook: boolean | null; pulled: Pulled | null }
  | { kind: "kept" }
  | { kind: "failed"; why: string };

/** After a destroy the instance list is read this often, for at most `GONE_MS`, until the box is not on it. */
const GONE_EVERY_MS = 5_000;
const GONE_MS = 2 * 60_000;

/** Read Vast.ai's instance list until the box is not on it; throws when it still is after two minutes. */
export async function waitGone(
  isListed: (id: number) => Promise<boolean>,
  id: number,
  sleep: (ms: number) => Promise<unknown>,
): Promise<void> {
  let unread = "";
  for (let waited = 0; ; waited += GONE_EVERY_MS) {
    try {
      if (!(await isListed(id))) return;
      unread = "";
    } catch (caught) {
      // A list that cannot be read now says nothing about the box: ask again.
      unread = ` (the last list read failed: ${caught instanceof Error ? caught.message : String(caught)})`;
    }
    if (waited >= GONE_MS) {
      throw new Error(
        `Vast.ai accepted the destroy of #${id}, but the box was still on its instance list after ${GONE_MS / 60_000} minutes${unread}`,
      );
    }
    await sleep(GONE_EVERY_MS);
  }
}
