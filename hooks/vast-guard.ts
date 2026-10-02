/**
 * A `PreToolUse` hook on `Bash`: sessions change Vast.ai only through the
 * `vast_*` tools, so the shapes that change it from a shell are refused, with
 * the tool to use instead in the reason.
 *
 *   - `vastai` or `vast` followed by create, launch, destroy, label, stop,
 *     start, reboot, recycle, update, copy or execute (by name or by path);
 *   - `vastlease`, the old lease program;
 *   - `curl`, `wget` or `http` with `-X` or `--request` PUT, POST or DELETE
 *     aimed at console.vast.ai.
 *
 * Only where a command word starts: `grep "vastai create" docs/` is a search
 * and passes, `yes y | /path/vastai destroy instance 1` is refused. A variable
 * (`$V destroy instance 1`) cannot be resolved here and passes: this stops the
 * usual shapes, not a determined script. Reads — `vastai show instances`,
 * `vastai search offers`, `vastai logs` — pass.
 *
 * It reads the hook's JSON from stdin and, to refuse, prints the deny
 * decision; to allow, it prints nothing. It imports nothing: the plugin runs
 * in a terminal session with no `node_modules`.
 */

/**
 * Where a command word starts: the line's start, after `;`, `&`, `|`, `(` or
 * a backtick, or inside `sh -c "…"`. Not after any quote: `grep "vastai"` is a
 * search, not a run. (From prifly's `tool-guard.ts`.)
 */
const COMMAND_START = String.raw`(?:^|[;&|(\x60\n]|-c\s+["'])\s*`;
/**
 * Words that run the next one: `nohup`, `timeout 30`, `env A=b`; and the
 * runners that start a Python tool by name. (From prifly's `tool-guard.ts`.)
 */
const WRAPPERS = String.raw`(?:(?:sudo|nohup|exec|setsid|nice|env(?:\s+\w+=\S*)*|timeout\s+\S+|start|uvx|pipx\s+run|uv\s+run|python3?\s+-m)\s+)*`;
/** A program by name or by path. */
const PROGRAM = String.raw`(?:\S*[/\\])?`;

const VERBS = "create|launch|destroy|label|stop|start|reboot|recycle|update|copy|execute";

/**
 * `vastai [global options] <verb>`. An option may take one value, which is not
 * itself a verb: `vastai --api-key KEY destroy instance 1`.
 */
const VASTAI_WRITE = new RegExp(
  `${COMMAND_START}${WRAPPERS}${PROGRAM}vast(?:ai)?(?:\\s+--?[\\w-]+(?:=\\S+)?(?:\\s+(?!(?:${VERBS})\\b)[^-\\s]\\S*)?)*\\s+(${VERBS})\\b`,
  "g",
);
const VASTLEASE = new RegExp(`${COMMAND_START}${WRAPPERS}${PROGRAM}vastlease\\b`);
const HTTP_TOOL = new RegExp(
  `${COMMAND_START}${WRAPPERS}${PROGRAM}(curl|wget|https?|xh)(?=\\s)`,
  "g",
);

/** A method that writes, given as a flag (`-X PUT`, `-XPOST`, `--request=DELETE`, wget's `--method`). */
const WRITE_FLAG = /(?:^|\s)(?:-X|--request|--method)[\s=]*['"]?(?:PUT|POST|DELETE)\b/i;
/** httpie's method is a word: `http PUT https://…`. */
const WRITE_WORD = /^(?:\s+-\S+)*\s+(?:PUT|POST|DELETE)\b/i;

const TOOLS =
  "Use the vast_* tools: vast_offers (search), vast_rent (rent, with a budget the reader confirms), vast_boxes (list, spend), vast_logs, vast_extend (more time or budget), vast_cancel (save and destroy).";

const BY_VERB: Readonly<Record<string, string>> = {
  create: "vast_rent",
  launch: "vast_rent",
  destroy: "vast_cancel",
  stop: "vast_cancel",
  label: "vast_rent (it labels the box itself)",
  start: "vast_boxes (to see it) — a stopped box is not started again; rent with vast_rent",
  reboot: "vast_boxes (to see it) — destroy with vast_cancel and rent again with vast_rent",
  recycle: "vast_cancel then vast_rent",
  update: "vast_cancel then vast_rent",
  copy: "no tool: ask the reader, or use scp over the box's ssh",
  execute: "no tool: use the box's ssh",
};

function reason(what: string, instead: string): string {
  return `Refused: ${what}. ${TOOLS} Here: ${instead}.`;
}

/** The text after a command word, up to the next separator that is not inside quotes. */
function simpleCommand(rest: string): string {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ";" || char === "&" || char === "|" || char === "\n") {
      return rest.slice(0, i);
    }
  }
  return rest;
}

/** Why a Bash command is refused, or null to let it run. */
export function refusal(command: string): string | null {
  for (const match of command.matchAll(VASTAI_WRITE)) {
    const verb = match[1] ?? "";
    return reason(
      `\`vastai ${verb}\` changes Vast.ai without the reader's say-so on the cost`,
      BY_VERB[verb] ?? "the vast_* tools",
    );
  }
  if (VASTLEASE.test(command)) {
    return reason(
      "`vastlease` is gone: leases and budgets belong to the tools",
      "vast_rent books the lease, vast_extend extends it, vast_cancel ends it, vast_boxes lists them",
    );
  }
  for (const match of command.matchAll(HTTP_TOOL)) {
    const rest = command.slice((match.index ?? 0) + match[0].length);
    const segment = simpleCommand(rest);
    if (!/console\.vast\.ai/i.test(segment)) continue;
    const word = (match[1] ?? "").startsWith("http") || match[1] === "xh";
    if (WRITE_FLAG.test(segment) || (word && WRITE_WORD.test(segment))) {
      return reason(
        "a write to console.vast.ai from a shell skips the budget the reader confirms",
        "vast_rent to rent, vast_cancel to destroy, vast_extend to extend",
      );
    }
  }
  return null;
}

/** The hook's answer that refuses the call and tells Claude why. */
export function deny(why: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: why,
    },
  };
}

/** The command of a hook's JSON, or null when it is not a Bash call. */
export function commandOf(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("tool_input" in parsed)) return null;
  const toolInput = parsed.tool_input;
  if (typeof toolInput !== "object" || toolInput === null || !("command" in toolInput)) return null;
  return typeof toolInput.command === "string" ? toolInput.command : null;
}

if (import.meta.main) {
  const command = commandOf(await Bun.stdin.text());
  const why = command === null ? null : refusal(command);
  if (why !== null) console.log(JSON.stringify(deny(why)));
}
