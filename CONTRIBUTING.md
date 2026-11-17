# Contributing to @particle-academy/fancy-git-github

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Layout

- `src/index.ts` — `GitHubProvider`, the whole adapter, over Octokit.
- `tests/` — the vitest suite (`provider.test.ts`, `issues.test.ts`).

## Commands

```bash
npm run build   # tsup
npm run lint    # tsc --noEmit
npm test        # vitest run
```

`prepublishOnly` runs lint, test and build in that order.

## Changelog

Update `CHANGELOG.md` (Keep a Changelog) in the same commit as the change.
