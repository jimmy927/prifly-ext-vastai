---
setup:
  - bun install --frozen-lockfile
---

A Bun project with one lockfile (`bun.lock`) and no workspaces. The install brings in
`zod` plus the dev tools the scripts use: `bun test` (tests in `test/`), `tsc --noEmit`
(typecheck) and `biome check .` (lint).

Relies on `bun` being on the PATH outside the worktree. Tests use a fake Vast.ai server
(`test/fake-vast.ts`), so no API key, network or `vastai` CLI is needed to run them.
