import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApiKeys } from "../vast-api";
import { fakes, homeWith } from "./fake-keys";

describe("the CLI's API key file is copied into the secrets once", () => {
  const migrated: [string, string][] = [
    ["apiKey", "file"],
    ["apiKeyMigrated", "1"],
  ];

  test("no secret, no vault entry: vast_api_key is copied, and used", async () => {
    const home = await homeWith(" file\n");
    const { sources, sets, logged } = fakes(null, null);
    expect(await readApiKeys({}, home, sources)).toEqual(["file"]);
    expect(sets).toEqual(migrated);
    expect(logged).toEqual([
      "api_key_migrated copied the vastai CLI's API key file into this extension's secrets",
    ]);
    // The next refresh finds the secret and copies nothing more.
    expect(await readApiKeys({}, home, sources)).toEqual(["file"]);
    expect(sets).toHaveLength(2);
  });

  test("$XDG_CONFIG_HOME moves the file that is copied", async () => {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    await mkdir(join(home, "xdg", "vastai"), { recursive: true });
    await writeFile(join(home, "xdg", "vastai", "vast_api_key"), "file");
    const { sources, sets } = fakes(null, null);
    const env = { XDG_CONFIG_HOME: join(home, "xdg") };
    expect(await readApiKeys(env, home, sources)).toEqual(["file"]);
    expect(sets).toEqual(migrated);
  });

  test("only the legacy ~/.vast_api_key: copied", async () => {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    await writeFile(join(home, ".vast_api_key"), "file\n");
    const { sources, sets } = fakes(null, null);
    expect(await readApiKeys({}, home, sources)).toEqual(["file"]);
    expect(sets).toEqual(migrated);
  });

  test("only the 2FA key: not copied, no marker, still tried as a fallback", async () => {
    const home = await homeWith(null);
    await writeFile(join(home, ".config", "vastai", "vast_tfa_key"), "tfa");
    const { sources, sets, logged } = fakes(null, null);
    expect(await readApiKeys({}, home, sources)).toEqual(["tfa"]);
    expect(sets).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("only $VAST_API_KEY: not copied", async () => {
    const home = await homeWith(null);
    const { sources, sets } = fakes(null, null);
    expect(await readApiKeys({ VAST_API_KEY: "env" }, home, sources)).toEqual(["env"]);
    expect(sets).toEqual([]);
  });

  test("an empty file is not copied", async () => {
    const home = await homeWith(" \n");
    const { sources, sets } = fakes(null, null);
    expect(await readApiKeys({}, home, sources)).toEqual([]);
    expect(sets).toEqual([]);
  });

  test("already migrated, secret removed: the file is not copied again, but still tried", async () => {
    const home = await homeWith("file\n");
    const { sources, sets } = fakes(null, null);
    await sources.secrets.set("apiKeyMigrated", "1");
    sets.length = 0;
    expect(await readApiKeys({}, home, sources)).toEqual(["file"]);
    expect(sets).toEqual([]);
  });

  test("a secret already set: the file is not copied, nothing is set", async () => {
    const home = await homeWith("file\n");
    const { sources, sets } = fakes("own", null);
    expect(await readApiKeys({}, home, sources)).toEqual(["own", "file"]);
    expect(sets).toEqual([]);
  });

  test("the vault entry wins over the file", async () => {
    const home = await homeWith("file\n");
    const { sources, sets } = fakes(null, "vaulted");
    expect(await readApiKeys({}, home, sources)).toEqual(["vaulted", "file"]);
    expect(sets).toEqual([
      ["apiKey", "vaulted"],
      ["apiKeyMigrated", "1"],
    ]);
  });

  test("a copy that fails is logged, and the file key is still used", async () => {
    const home = await homeWith("file\n");
    const { sources, logged } = fakes(null, null);
    const failing = {
      ...sources,
      secrets: {
        get: sources.secrets.get,
        set: async () => {
          throw new Error("secrets are stopped");
        },
      },
    };
    expect(await readApiKeys({}, home, failing)).toEqual(["file"]);
    expect(logged).toEqual(["api_key_migrate_failed secrets are stopped"]);
  });
});
