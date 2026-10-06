/**
 * A copy of prifly's extension contract (apps/desktop-host/src/extensions/api.ts
 * in jimmy927/prifly), kept here so this extension type-checks on its own.
 *
 * What an extension is given, and what it gives back — the whole contract.
 *
 * An extension is a folder with a `prifly-extension.json` manifest and a
 * TypeScript or JavaScript module the host imports:
 *
 *     { "id": "vastai", "name": "Vast.ai boxes", "main": "index.ts",
 *       "description": "…", "version": "0.1.0" }
 *
 * The module exports `activate(api)`, which may return a function the host
 * calls to stop it. It runs inside the host, with the host's rights: enable
 * only extensions you would run yourself.
 */

export type DecorationTone = "good" | "warning" | "critical" | "info" | "muted";

/** One of the icons the window has: see `DECORATION_ICONS` in `@prifly/wire`. */
export type DecorationIcon =
  | "server"
  | "cpu"
  | "gpu"
  | "hard-drive"
  | "cloud"
  | "box"
  | "zap"
  | "activity"
  | "dollar"
  | "clock"
  | "alert"
  | "check"
  | "link"
  | "dot";

export type Decoration = {
  /** Stable within the extension, so the window keeps an item's place. */
  key: string;
  icon: DecorationIcon;
  /** A few words: "lc-box1 $0.42/h". */
  label: string;
  tone: DecorationTone;
  /** Shown on hover, one line each. */
  details: string[];
  /**
   * What a click on the item opens: a program in a terminal window of
   * prifly's own — `ssh` to a Vast.ai box. Run without a shell, as the reader.
   */
  terminal?: { title: string; command: string[] } | undefined;
  /**
   * The item's right-click menu. Choosing one calls the handler given to
   * `api.onAction` with the item's key and the action's id — after asking
   * the reader `confirm`, when it is not "".
   */
  actions?: DecorationAction[] | undefined;
  /**
   * The `id` of one of this extension's own panels that the item is the state
   * of. Only for the `unclaimed` items of `show`: the status bar then draws no
   * chip, but that panel's button, its icon coloured by `tone`, its hover
   * holding `label` and `details`. An older prifly draws an ordinary chip.
   */
  panel?: string | undefined;
};

export type DecorationAction = {
  id: string;
  /** The menu's words: "Destroy box…". */
  label: string;
  /** Asked before it runs: what it will do and what is lost. */
  confirm?: string | undefined;
  /** Drawn in the danger colour. */
  destructive?: boolean | undefined;
  /** Shown but not choosable, so the menu keeps its shape. */
  disabled?: boolean;
};

/** A session the host knows, for an extension to match its things against. */
export type ExtensionSession = { id: string; title: string; cwd: string; state: string };

/**
 * One machine this extension offers sessions to use — a rented box — or,
 * with `kind: "provider"`, itself, when it can rent more. Ids are namespaced
 * `ext:<extension id>:<key>` before a session sees them, so `key` needs only
 * be unique within this extension. Fields left out take `Machine`'s own
 * defaults in prifly's wire package: `os` "other", `trust` "ask-first".
 */
export type ExtensionMachine = {
  key: string;
  kind?: "machine" | "provider" | "service";
  label: string;
  os?: string;
  arch?: string;
  /** The argv that runs a command there: `["ssh","root@1.2.3.4","-p","2222"]`. */
  exec?: string[];
  access?: string;
  trust?: "ask-first" | "use-freely";
  notes?: string;
  capabilities?: {
    name: string;
    state?: "present" | "absent" | "unknown";
    version?: string;
    detail?: string;
    probe?: string;
  }[];
  /** The session (or its first 8 characters) that rented it, for whom it is use-freely. */
  ownerSession?: string;
  status?: { text: string; tone?: DecorationTone };
  actions?: DecorationAction[];
};

/** An amount the reader confirms with the row (a rental's budget). */
export type PickAmount = {
  /** "Budget for this rental" */
  label: string;
  /** "$" */
  prefix: string;
  /** The session's suggestion; the reader may change it. */
  value: number;
  /** One line under the field: how the suggestion was made, what it means. */
  hint: string;
  /**
   * Recompute one column from the amount as the reader types: each row's
   * `column` cell becomes `amount / Number(row[rateColumn])` with `unit`,
   * and its header "Hours in <prefix><amount>".
   */
  perRow?: { column: string; rateColumn: string; unit: string };
  /**
   * A soft limit: `text` is always shown under the hint; past `max` the field
   * warns with `over`, and the button waits until the reader ticks `ack`.
   * Only on a prifly whose `features` include "pick-amount-limit": an older
   * one refuses the field.
   */
  limit?: { max: number; text: string; over: string; ack: string };
};

/** What an extension tool asks the reader: prifly's pick card, optionally with an amount. */
export type ExtensionPick = {
  title: string;
  columns: string[];
  rows: string[][];
  /**
   * A link for each cell: one URL or null per cell, the same shape as `rows`.
   * Only on a prifly whose `features` include "pick-links": an older one
   * refuses the field.
   */
  links?: (string | null)[][];
  /**
   * Hover text for each cell: one string or null per cell, the same shape as
   * `rows`. Only on a prifly whose `features` include "pick-cells": an older
   * one refuses the field.
   */
  titles?: (string | null)[][];
  /**
   * How each cell is drawn, the same shape as `rows`: "flag" draws the cell's
   * text (an ISO 3166-1 alpha-2 country code) as that country's flag, "link-icon"
   * draws an icon that opens the cell's `links` URL, null is plain text. The
   * cell's text stays what a screen reader and an older prifly show. Only on a
   * prifly whose `features` include "pick-cells": an older one refuses the field.
   */
  cellKinds?: ("flag" | "link-icon" | null)[][];
  /** The button's word, default "Choose". */
  action?: string;
  amount?: PickAmount;
};

/** The reader's answer: the row and, when the pick had one, the amount they confirmed. Null: none of these. */
export type ExtensionPickAnswer = { row: number; amount: number | null } | null;

export type ExtensionToolContext = {
  /** The full id of the session that called the tool. */
  session: string;
  /** Show a pick card in that session and wait for the reader. */
  pick(request: ExtensionPick): Promise<ExtensionPickAnswer>;
  /** Aborted when the session or the call goes away. */
  signal: AbortSignal;
};

export type ExtensionTool = {
  /** `^[a-z][a-z0-9_]{0,47}$`; the session sees it as `mcp__prifly__<name>`. */
  name: string;
  description: string;
  /** A JSON Schema object for the arguments. */
  inputSchema: Record<string, unknown>;
  /** The text the tool returns. A throw is returned as an MCP tool error with its message. */
  call(args: Record<string, unknown>, ctx: ExtensionToolContext): Promise<string>;
};

/** Added to `ExtensionApi`. Absent on an older prifly: call it as `api.tools?.register(...)`. */
export type ExtensionToolsApi = {
  /** Replace every tool this extension serves. A name another extension or prifly owns is refused and logged. */
  register(tools: ExtensionTool[]): void;
};

/** Added to `ExtensionApi`. Absent on an older prifly: call it as `api.vault?.read(...)`. */
export type ExtensionVaultApi = {
  /**
   * The token of the vault entry `name`, an `api-token` entry the reader keeps
   * in prifly's vault. Null when there is no such entry, it is another kind,
   * the manifest's `vault` list does not name it, or its level is not 1.
   */
  read(name: string): Promise<string | null>;
};

export type ExtensionApi = {
  /** What this prifly host can do beyond the base contract: "pick-amount-limit", "pick-links", "pick-cells". Absent on an older one. */
  features?: readonly string[];
  /**
   * The vault's API tokens this extension's manifest names under `vault`.
   * Absent on a prifly host older than "extension vault" — call it as
   * `api.vault?.read(...)`; without it the key comes from its files.
   */
  vault?: ExtensionVaultApi;
  /**
   * Replace everything this extension shows. `bySession` is keyed by a
   * session id or any unique start of one (a label has room for 8 characters);
   * items for an id no session has, and `unclaimed`, go to the status bar.
   */
  show(bySession: Record<string, Decoration[]>, unclaimed: Decoration[]): void;
  /**
   * Replace every machine this extension offers sessions to use, the whole
   * list each time. Absent on a prifly host older than the "machines"
   * feature — call it as `api.machines?.report(...)`.
   */
  machines?: { report(items: ExtensionMachine[]): void };
  /**
   * Carry out an action the reader chose from an item's right-click menu.
   * What it returns is shown to them ("Destroyed lc-box1"); what it throws is
   * shown as the failure. One handler per extension; a second call replaces it.
   */
  onAction(handler: (key: string, action: string) => Promise<string> | string): void;
  /**
   * Tell the reader something that cannot wait for them to look at a chip,
   * under the extension's name; `session` makes a click open that session.
   * Absent on a prifly host older than "notify" — call it as `api.notify?.(…)`.
   */
  notify?(text: string, options?: { tone?: DecorationTone; session?: string }): void;
  /**
   * Serve MCP tools to every session prifly runs, as `mcp__prifly__<name>`.
   * Absent on a prifly host older than "extension tools": call it as
   * `api.tools?.register(...)`; without it the extension is still a box display.
   */
  tools?: ExtensionToolsApi;
  /** The sessions on this machine the host knows now. */
  sessions(): ExtensionSession[];
  /** A line in the host's log, under `ext.<id>.<event>`. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** The extension's own folder: where it keeps its config. */
  folder: string;
  /**
   * The folders its programs are in, first on the PATH of every session
   * prifly runs: its manifest's `bin`, and the `bin` of a `.venv` prifly
   * builds from a `pyproject.toml` and `uv.lock`. This extension ships none.
   */
  paths: readonly string[];
};

/**
 * A request from one of the extension's own windows (`panels` in the
 * manifest): the page fetched `api/<path>` beside itself. `query` is the
 * URL's query; `body` a POST's JSON, or null.
 */
export type PanelRequest = {
  path: string;
  query: Record<string, string>;
  body: unknown;
};

export type ExtensionModule = {
  activate: (api: ExtensionApi) => (() => void) | undefined | Promise<(() => void) | undefined>;
  /**
   * What one of its windows asks for: `panelId` names the manifest's panel.
   * Answered as JSON; a throw becomes a 500 whose body is `{ error }`.
   */
  panel?: (panelId: string, request: PanelRequest) => unknown;
};
