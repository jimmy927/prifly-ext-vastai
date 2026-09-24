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
};

export type DecorationAction = {
  id: string;
  /** The menu's words: "Destroy box…". */
  label: string;
  /** Asked before it runs: what it will do and what is lost. */
  confirm?: string | undefined;
  /** Drawn in the danger colour. */
  destructive?: boolean | undefined;
};

/** A session the host knows, for an extension to match its things against. */
export type ExtensionSession = { id: string; title: string; cwd: string; state: string };

export type ExtensionApi = {
  /**
   * Replace everything this extension shows. `bySession` is keyed by a
   * session id or any unique start of one (a label has room for 8 characters);
   * items for an id no session has, and `unclaimed`, go to the status bar.
   */
  show(bySession: Record<string, Decoration[]>, unclaimed: Decoration[]): void;
  /**
   * Carry out an action the reader chose from an item's right-click menu.
   * What it returns is shown to them ("Destroyed lc-box1"); what it throws is
   * shown as the failure. One handler per extension; a second call replaces it.
   */
  onAction(handler: (key: string, action: string) => Promise<string> | string): void;
  /** The sessions on this machine the host knows now. */
  sessions(): ExtensionSession[];
  /** A line in the host's log, under `ext.<id>.<event>`. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** The extension's own folder: where it keeps its config. */
  folder: string;
  /**
   * The folders its programs are in, first on the PATH of every session
   * prifly runs: its manifest's `bin`, and the `bin` of the `.venv` prifly
   * builds from its `pyproject.toml` and `uv.lock` (prifly brings uv and the
   * Python; the extension ships neither).
   */
  paths: readonly string[];
};

export type ExtensionModule = {
  activate: (api: ExtensionApi) => (() => void) | undefined | Promise<(() => void) | undefined>;
};
