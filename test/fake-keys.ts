/**
 * A fake `api.secrets` and `api.vault`, and a temp HOME with the CLI's config
 * folder, for the tests of where the Vast.ai API key is read from.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fake `api.secrets` and `api.vault`, each call written down. */
export function fakes(stored: string | null, vaulted: string | null) {
  const calls: string[] = [];
  const sets: [string, string | null][] = [];
  const logged: string[] = [];
  const values = new Map<string, string | null>([["apiKey", stored]]);
  return {
    calls,
    sets,
    logged,
    sources: {
      secrets: {
        get: async (key: string) => {
          calls.push(`secrets.get ${key}`);
          return values.get(key) ?? null;
        },
        set: async (key: string, next: string | null) => {
          sets.push([key, next]);
          values.set(key, next);
        },
      },
      vault: {
        read: async (name: string) => {
          calls.push(`vault.read ${name}`);
          return vaulted;
        },
      },
      log: (event: string, fields?: Record<string, unknown>) =>
        logged.push(`${event} ${String(fields?.["message"] ?? "")}`),
    },
  };
}

/** A temp HOME with `.config/vastai/`, holding `vast_api_key` when `file` is given. */
export async function homeWith(file: string | null) {
  const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
  await mkdir(join(home, ".config", "vastai"), { recursive: true });
  if (file !== null) await writeFile(join(home, ".config", "vastai", "vast_api_key"), file);
  return home;
}
