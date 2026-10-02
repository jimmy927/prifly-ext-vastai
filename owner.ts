/**
 * Whose boxes this prifly manages: the owner part of `<owner>/s-<session8>/<name>`.
 *
 * `"owner"` in the extension's `config.json` if set, else `$USER`, as
 * `ownerName` in `rules.ts` makes it. The extension and its tools both read it
 * here, so a box a session rents carries the owner the extension manages.
 */

import { join } from "node:path";
import { ownerName } from "./rules";

export async function readOwner(
  folder: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const config: unknown = await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}));
  const configured =
    typeof config === "object" && config !== null && "owner" in config ? config.owner : undefined;
  const owner = ownerName(typeof configured === "string" ? configured : (env["USER"] ?? ""));
  if (owner === "") {
    throw new Error('No owner for the Vast.ai labels: set "owner" in config.json, or $USER');
  }
  return owner;
}
