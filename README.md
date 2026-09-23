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

## Writing an extension

An extension is a folder with a `prifly-extension.json` manifest and a module:

```json
{ "id": "vastai", "name": "Vast.ai boxes", "main": "index.ts", "version": "0.1.0" }
```

The module exports `activate(api)`, which may return a function prifly calls
to stop it. `api.show(bySession, unclaimed)` replaces everything the extension
shows: items per session id (or any unique start of one), and items no
session owns. Each item is an icon from a fixed set, a short label, a tone
(`good`, `warning`, `critical`, `info`, `muted`) and lines shown on hover.
`prifly-api.ts` in this repository is the whole contract.

Extensions run inside prifly's host with its rights, which is why prifly
starts none until you enable it.
