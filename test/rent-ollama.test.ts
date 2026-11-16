import { describe, expect, test } from "bun:test";
import { OLLAMA_IMAGE, SSH_KEY_REPAIR } from "../rent";
import { ctxFor, offer, setup, vast } from "./fake-vast";

const MODELS = ["qwen2.5-coder:7b", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"];
const RENT = {
  name: "oll1",
  budget: 5,
  offers: [101],
  disk_gb: 60,
  purpose: "serve local models for prifly",
  need: "gpu" as const,
  need_note: "one GPU with 16 GB VRAM",
  ollama: { models: MODELS },
};

async function rented(args: Record<string, unknown>) {
  const fake = vast([offer(101, 0.5)]);
  const { tool } = await setup(fake);
  const { ctx, cards } = ctxFor([{ row: 0, amount: 5 }]);
  await tool("vast_rent").call({ ...RENT, ...args }, ctx);
  const body = (fake.puts[0]?.body ?? {}) as { image: string; onstart: string; env: object };
  return { body, card: cards[0], fake };
}

describe("vast_rent with ollama", () => {
  test("the image defaults to ollama/ollama and needs no image argument", async () => {
    const { body } = await rented({});
    expect(body.image).toBe(OLLAMA_IMAGE);
  });

  test("an image given with ollama is kept", async () => {
    const { body } = await rented({ image: "ubuntu:22.04" });
    expect(body.image).toBe("ubuntu:22.04");
  });

  test("the onstart starts with the ssh repair, binds loopback and pulls both models quoted", async () => {
    const { body } = await rented({});
    expect(body.onstart.startsWith(`${SSH_KEY_REPAIR}\n`)).toBe(true);
    expect(body.onstart).toContain("OLLAMA_HOST=127.0.0.1:11434");
    expect(body.onstart).toContain("OLLAMA_KEEP_ALIVE=-1");
    expect(body.onstart).toContain("OLLAMA_CONTEXT_LENGTH=65536");
    expect(body.onstart).toContain("nohup ollama serve >>/var/log/ollama.log");
    expect(body.onstart).toContain("ollama pull 'qwen2.5-coder:7b'");
    expect(body.onstart).toContain(
      "ollama pull 'hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M'",
    );
    expect(body.onstart).not.toMatch(/pkill|HUP/);
    // The server is up before the first pull, and the box is kept up after the last.
    const at = (text: string) => body.onstart.indexOf(text);
    expect(at("ollama serve")).toBeLessThan(at("ollama list"));
    expect(at("ollama list")).toBeLessThan(at("ollama pull"));
    expect(body.onstart.endsWith("sleep infinity")).toBe(true);
  });

  test("a context length overrides the default, in the script and in env", async () => {
    const { body } = await rented({ ollama: { models: MODELS, context_length: 32768 } });
    expect(body.onstart).toContain("OLLAMA_CONTEXT_LENGTH=32768");
    expect(body.onstart).not.toContain("65536");
    expect(body.env).toMatchObject({
      OLLAMA_HOST: "127.0.0.1:11434",
      OLLAMA_CONTEXT_LENGTH: "32768",
      OLLAMA_KEEP_ALIVE: "-1",
    });
  });

  test("no port is mapped to 11434", async () => {
    const { body } = await rented({});
    expect(Object.keys(body.env).filter((key) => key.startsWith("-p "))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/-p [^"]*11434/);
  });

  test("a port 11434 given with ollama is refused before any card", async () => {
    for (const ports of [["11434:11434/tcp"], ["8080:11434"], ["11434"]]) {
      const fake = vast([offer(101, 0.5)]);
      const { tool } = await setup(fake);
      const { ctx, cards } = ctxFor([{ row: 0, amount: 5 }]);
      await expect(tool("vast_rent").call({ ...RENT, ports }, ctx)).rejects.toThrow(/11434/);
      expect(cards).toEqual([]);
      expect(fake.puts).toEqual([]);
    }
  });

  test("an onstart given with ollama is refused", async () => {
    const fake = vast([offer(101, 0.5)]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([{ row: 0, amount: 5 }]);
    await expect(tool("vast_rent").call({ ...RENT, onstart: "echo hi" }, ctx)).rejects.toThrow(
      /either ollama or onstart/,
    );
    expect(cards).toEqual([]);
    expect(fake.puts).toEqual([]);
  });

  test("model names outside the safe charset, and an empty list, are refused", async () => {
    const { tool } = await setup(vast([offer(101, 0.5)]));
    for (const bad of ["a b", "x; rm -rf /", "$(id)", "it's", "-rf", "a`b`", ""]) {
      const { ctx } = ctxFor([{ row: 0, amount: 5 }]);
      await expect(
        tool("vast_rent").call({ ...RENT, ollama: { models: [bad] } }, ctx),
      ).rejects.toThrow();
    }
    const { ctx } = ctxFor([{ row: 0, amount: 5 }]);
    await expect(
      tool("vast_rent").call({ ...RENT, ollama: { models: [] } }, ctx),
    ).rejects.toThrow();
  });

  test("the card says the box is an Ollama model provider and names the models", async () => {
    const { card } = await rented({});
    expect(card?.title).toContain("Ollama model provider: qwen2.5-coder:7b, hf.co/bartowski");
    expect(card?.title).toContain("serve local models for prifly");
    expect(card?.amount?.hint).toContain("Ollama model provider");
  });

  test("without ollama the image is still required", async () => {
    const { tool } = await setup(vast([offer(101, 0.5)]));
    const { ollama: _ollama, ...plain } = RENT;
    const { ctx } = ctxFor([{ row: 0, amount: 5 }]);
    await expect(tool("vast_rent").call(plain, ctx)).rejects.toThrow(/image is required/);
  });
});
