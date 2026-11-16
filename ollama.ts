/**
 * The `ollama` option of `vast_rent`: its arguments and the onstart that serves
 * Ollama on the box's own loopback for prifly's model providers.
 */

import { z } from "zod";

/** An Ollama model name such as `llama3.2:3b` or `hf.co/<user>/<repo>:Q4_K_M`: no quote, space, `$` or leading dash can get through. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,199}$/;
export const OLLAMA_PORT = 11434;
export const OLLAMA_IMAGE = "ollama/ollama";
export const OLLAMA_CONTEXT_DEFAULT = 65536;

export const OllamaArgs = z.strictObject({
  models: z
    .array(z.string().regex(MODEL, "not an Ollama model name (letters, digits, . _ - / : @)"))
    .min(1)
    .max(8)
    .describe('Models to pull, e.g. "qwen2.5-coder:7b" or "hf.co/<user>/<repo>:Q4_K_M".'),
  context_length: z
    .number()
    .int()
    .min(512)
    .max(1048576)
    .optional()
    .describe(`OLLAMA_CONTEXT_LENGTH, default ${OLLAMA_CONTEXT_DEFAULT}.`),
});
type OllamaOptions = z.infer<typeof OllamaArgs>;

/** `'...'` for the shell, whatever the text holds. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The onstart that serves Ollama on the box's own loopback: the server in the
 * background (its log in /var/log/ollama.log), a wait until the API answers,
 * each model pulled, then the box kept up. Vast's ssh launch mode replaces the
 * image's `ollama` entrypoint and runs this, so `ollama serve` is started here.
 * 11434 is bound to 127.0.0.1 and never mapped: prifly tunnels to it over ssh.
 */
export function ollamaScript({ models, context_length }: OllamaOptions): string {
  const context = context_length ?? OLLAMA_CONTEXT_DEFAULT;
  return [
    `export OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} OLLAMA_CONTEXT_LENGTH=${context} OLLAMA_KEEP_ALIVE=-1`,
    "nohup ollama serve >>/var/log/ollama.log 2>&1 &",
    "SERVE_PID=$!",
    "for _ in $(seq 1 150); do ollama list >/dev/null 2>&1 && break; sleep 2; done",
    // So that `ssh box curl 127.0.0.1:11434/api/tags` works; the image may not ship curl.
    "command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; } >>/var/log/ollama.log 2>&1 || true",
    ...models.map(
      (model) =>
        `ollama pull ${quoted(model)} >>/var/log/ollama-pull.log 2>&1 || echo ${quoted(`pull failed: ${model}`)} >>/var/log/ollama-pull.log`,
    ),
    'wait "$SERVE_PID"',
    "sleep infinity",
  ].join("\n");
}
