import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwner } from "../owner";

const folder = (config?: object) =>
  mkdtemp(join(tmpdir(), "vastai-owner-")).then(async (dir) => {
    if (config !== undefined) await Bun.write(join(dir, "config.json"), JSON.stringify(config));
    return dir;
  });

/** No OS account name: the tests never depend on who runs them. */
const noAccount = () => "";

test("the owner is config.json's, made a label part", async () => {
  expect(await readOwner(await folder({ owner: "Laptop.Jimmy" }), { USER: "x" }, () => "y")).toBe(
    "laptopjimmy",
  );
});

test("without one in config.json it is $USER, at most 16 characters", async () => {
  expect(await readOwner(await folder({ enforce: true }), { USER: "Jimmy" }, noAccount)).toBe(
    "jimmy",
  );
  expect(await readOwner(await folder(), { USER: "a-very-long-user-name" }, noAccount)).toBe(
    "a-very-long-user",
  );
});

test("then %USERNAME%, then the OS account's name", async () => {
  const dir = await folder();
  expect(await readOwner(dir, { USER: "a", USERNAME: "b" }, () => "c")).toBe("a");
  expect(await readOwner(dir, { USERNAME: "b" }, () => "c")).toBe("b");
  expect(await readOwner(dir, { USER: "", USERNAME: "b" }, () => "c")).toBe("b");
  expect(await readOwner(dir, {}, () => "c")).toBe("c");
});

test("Windows' USERNAME gives the label WSL's USER gave, so rented boxes stay ours", async () => {
  const dir = await folder();
  expect(await readOwner(dir, { USERNAME: "jimmy" }, noAccount)).toBe(
    await readOwner(dir, { USER: "jimmy" }, noAccount),
  );
});

test("no owner at all is refused, never guessed", async () => {
  await expect(readOwner(await folder(), {}, noAccount)).rejects.toThrow("No owner");
  await expect(readOwner(await folder(), {}, () => "åäö")).rejects.toThrow("No owner");
  await expect(
    readOwner(await folder({ owner: "åäö" }), { USER: "jimmy" }, noAccount),
  ).rejects.toThrow("No owner");
});
