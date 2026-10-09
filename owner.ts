/**
 * Whose boxes this prifly manages: the owner part of `<owner>/s-<session8>/<name>`.
 *
 * `"owner"` in the extension's `config.json` if set, else `$USER` (Linux, macOS,
 * WSL), else `%USERNAME%` (native Windows, which has no `USER`), else the OS
 * account's name, as `ownerName` in `rules.ts` makes it. The same account
 * gives the same owner from WSL and from Windows, so boxes rented from one are
 * still recognised from the other. The extension and its tools both read it
 * here, so a box a session rents carries the owner the extension manages.
 */

import { userInfo } from "node:os";
import { join } from "node:path";
import { ownerName } from "./rules";

/** The OS account's name; "" when the OS cannot say (no passwd entry, a sandbox). */
function accountName(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

export async function readOwner(
  folder: string,
  env: Record<string, string | undefined>,
  account: () => string = accountName,
): Promise<string> {
  const config: unknown = await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}));
  const configured =
    typeof config === "object" && config !== null && "owner" in config ? config.owner : undefined;
  const raw =
    typeof configured === "string" ? configured : env["USER"] || env["USERNAME"] || account();
  const owner = ownerName(raw);
  if (owner === "") {
    throw new Error(
      'No owner for the Vast.ai labels: set "owner" in config.json, or $USER / %USERNAME%',
    );
  }
  return owner;
}
