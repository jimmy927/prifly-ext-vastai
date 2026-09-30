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

test("the owner is config.json's, made a label part", async () => {
  expect(await readOwner(await folder({ owner: "Laptop.Jimmy" }), { USER: "x" })).toBe(
    "laptopjimmy",
  );
});

test("without one in config.json it is $USER, at most 16 characters", async () => {
  expect(await readOwner(await folder({ enforce: true }), { USER: "Jimmy" })).toBe("jimmy");
  expect(await readOwner(await folder(), { USER: "a-very-long-user-name" })).toBe(
    "a-very-long-user",
  );
});

test("no owner at all is refused, never guessed", async () => {
  await expect(readOwner(await folder(), {})).rejects.toThrow("No owner");
  await expect(readOwner(await folder({ owner: "åäö" }), { USER: "jimmy" })).rejects.toThrow(
    "No owner",
  );
});
