/**
 * Which repository a session's folder is in, for the spend panel's "by
 * repository": its origin's `owner/name`, so every worktree and clone of one
 * repository is that one repository.
 *
 * A worktree's `.git` file points back to its main checkout, whose
 * `.git/config` names the origin. A folder that is gone is placed by its path
 * (`x.worktrees/y` is x's), and a cloud session's "folder" is the repository's
 * URL already. Adapted from prifly-ext-token-stats' `where.ts`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const NO_REPO = "(no repository)";

/** `https://github.com/o/r.git`, `git@github.com:o/r` or `https://github.com/o/r@main` as `o/r`. */
export function repoOfUrl(url: string): string | null {
  const match = /[/:]([^/:]+)\/([^/@]+?)(\.git)?(@.*)?\/?$/.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function mainOfWorktree(gitFile: string): string | null {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitFile, "utf8"))?.[1]?.trim();
  if (gitdir === undefined) return null;
  const at = gitdir.indexOf("/.git/worktrees/");
  return at < 0 ? null : gitdir.slice(0, at);
}

function gitTop(cwd: string): string | null {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (!existsSync(git)) continue;
    return statSync(git).isFile() ? (mainOfWorktree(git) ?? dir) : dir;
  }
  return null;
}

function originOf(top: string): string {
  try {
    const config = readFileSync(join(top, ".git", "config"), "utf8");
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    if (origin !== undefined) return repoOfUrl(origin) ?? basename(top);
  } catch {
    // No config: the folder's name is the best there is.
  }
  return basename(top);
}

/** The repository of a session's folder. */
export function repoOfFolder(cwd: string): string {
  if (cwd === "") return NO_REPO;
  if (/^(https?:|git@)/.test(cwd)) return repoOfUrl(cwd) ?? NO_REPO;
  try {
    if (existsSync(cwd)) {
      const top = gitTop(cwd);
      if (top !== null) return originOf(top);
    }
  } catch {
    // Unreadable on the way up: placed by its path below.
  }
  const main = /^(.*?)\.worktrees\//.exec(cwd)?.[1];
  if (main !== undefined) return existsSync(join(main, ".git")) ? originOf(main) : basename(main);
  return NO_REPO;
}
