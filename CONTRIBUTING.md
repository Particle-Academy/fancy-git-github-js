# Contributing to @particle-academy/fancy-git-github

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Layout

- `src/index.ts` — `GitHubProvider`, the whole adapter.
- `src/client.ts` — `GitHubClient`, the first-party REST client on global
  `fetch` (auth, pinned API version, Link parsing, typed errors, rate limits,
  retries). It replaced octokit on 2026-11-19: do not add an SDK back. Paths are
  built with the `path` tag, which URL-encodes every interpolated value.
- `tests/` — the vitest suite. `transport.test.ts` asserts what each operation
  puts on the wire through a fake `fetch` (`tests/support/`); those assertions
  were recorded against the octokit version before the swap.
  `tests/support/make-provider.ts` is the only place the tests know how the
  provider reaches HTTP.

## Commands

```bash
npm run build   # tsup
npm run lint    # tsc --noEmit
npm test        # vitest run
```

`prepublishOnly` runs lint, test and build in that order.

## Changelog

Update `CHANGELOG.md` (Keep a Changelog) in the same commit as the change.
