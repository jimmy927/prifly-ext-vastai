import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../index";

const folderWith = async (config?: string) => {
  const folder = await mkdtemp(join(tmpdir(), "vastai-config-"));
  if (config !== undefined) await writeFile(join(folder, "config.json"), config);
  return folder;
};

test("with no config.json, lease enforcement is on", async () => {
  expect((await readConfig(await folderWith())).enforce).toBe(true);
});

test("a config.json that does not mention enforce, or cannot be read, leaves it on", async () => {
  expect((await readConfig(await folderWith('{"refreshSeconds": 30}'))).enforce).toBe(true);
  expect((await readConfig(await folderWith("{not json"))).enforce).toBe(true);
});

test("only an explicit false turns enforcement off", async () => {
  expect((await readConfig(await folderWith('{"enforce": false}'))).enforce).toBe(false);
  expect((await readConfig(await folderWith('{"enforce": true}'))).enforce).toBe(true);
});
