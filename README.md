# prifly-ext-vastai

A [prifly](https://github.com/jimmy927/prifly) extension that shows each rented
[Vast.ai](https://vast.ai) box on the session that rented it — an icon on the
session's row in the sidebar, and a chip under the goal when the session is
open, coloured by how busy the box is. Boxes no session claims show in the
status bar.

It is also the example to copy when writing an extension of your own.

## How a box finds its session

A box belongs to the session whose id starts its label:

    s-<first 8 characters of the session id>/<name>      e.g.  s-e5636c90/lc-box1

prifly tells every session it runs its own id, so a session can label what it
rents: `vastai create instance … --label s-e5636c90/lc-box1`, or later
`vastai label instance <id> s-e5636c90/lc-box1`.

## Install

In prifly: status bar → the puzzle icon → **Vast.ai boxes** → Install, then
tick it to enable it. Or clone this repository into
`~/.local/share/prifly/extensions/`.

If `vastai` is not on the PATH, copy `config.example.json` to `config.json`
and point `vastai` at it.

## What it brings

- **A display** — each box on its session in prifly (`index.ts`).
- **A Claude Code skill** — `skills/vastai`: renting without surprise bills,
  labelling, cleanup. The repository is also a Claude Code plugin and its own
  marketplace, so terminal sessions can have it too:

      claude plugin marketplace add jimmy927/prifly-ext-vastai
      claude plugin install vastai@prifly-ext-vastai

  prifly loads it into the sessions it runs while the extension is enabled
  (and does not load it twice if Claude Code already has it installed).
- **A menu item** — right-click a session → **Rent a Vast.ai machine…**:
  describe what you need; the session has a subagent find the 10 best offers
  with the skill, shows them in a table to pick from, and rents the one you
  choose, labelled with that session.
- **Instructions** — `prompt.md`, added to the system prompt of every session
  prifly runs: label what you rent with your session.

## Writing an extension

An extension is a folder with a `prifly-extension.json` manifest. Every part
is optional; use the ones your idea needs:

```json
{ "id": "vastai", "name": "Vast.ai boxes", "version": "0.2.0",
  "main": "index.ts", "prompt": "prompt.md" }
```

- **`main`** — a module the host imports. It exports `activate(api)`, which
  may return a function prifly calls to stop it. `api.show(bySession,
  unclaimed)` replaces everything it shows: items per session id (or any
  unique start of one), and items no session owns. Each item is an icon from a
  fixed set, a short label, a tone (`good`, `warning`, `critical`, `info`,
  `muted`) and lines shown on hover. `prifly-api.ts` here is the whole
  contract.
- **`menu`** — items for a session's right-click menu: a label, an icon, an
  optional input dialog (`input.title`, `input.placeholder`), and a `prompt`
  sent to that session with `{input}`, `{sessionId}` and `{session8}` filled
  in. Sessions prifly runs can also show a table to pick a row from with the
  `mcp__prifly__pick` tool.
- **`prompt`** — a Markdown file whose text is added to the system prompt of
  every session prifly starts, after prifly's own note.
- **A Claude Code plugin** — `.claude-plugin/plugin.json` in the same folder,
  with `skills/`, `agents/`, `commands/`, `hooks/`… prifly passes the folder to
  its sessions with `--plugin-dir`.

Skills, instructions and plugins reach a session when its process starts. In
prifly, "Apply to idle sessions" in the Extensions dialog restarts the ones
only waiting for you so they get a change at once.

Extensions run inside prifly's host with its rights, which is why prifly
starts none until you enable it.
