# Changelog

All notable changes to `@particle-academy/fancy-git-github` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0: breaking changes land in MINOR releases.** Read the entry, not the
> version number.

## [Unreleased]

### Fixed

- **`CHANGELOG.md` is now in the published tarball.** `files` did not whitelist it, so npm never shipped it — and this package puts breaking changes in MINOR releases and tells you in the README to read the entry before taking one. The instruction existed for the author, who has the file, and not for the consumer, who is the only one being instructed. Nothing for you to do; the file simply arrives from this release on.

### Security

- `source-map-js` is pinned forward to `^1.2.2` via `overrides`. Versions up to
  1.2.1 allow an event-loop denial of service through indexed source-map section
  offsets, and it arrives here transitively through the build toolchain.
  **Nothing for a consumer to do, and no runtime change**: an npm package does
  not ship a lockfile, so this governs builds OF this repo, not anything
  installed FROM it. Recorded rather than left silent because the override it
  sits beside — `shell-quote` `^1.9.0`, added for an earlier advisory — was
  carried with no note of why, and had drifted back inside the vulnerable range
  before anyone looked.

## [0.3.0] — 2026-08-07

### Changed

- **BREAKING — Node 20 is no longer supported.** `engines.node` moves from `>=20` to `>=22`.

  **What you must do:** on Node 22 or newer, nothing. Note npm only *warns* on an `engines` mismatch while **pnpm fails the install**, so this surfaces differently depending on your package manager. Node 18 is end-of-life and 20 is maintenance-only.

### Why

These are the kit 0.5 platform floors, applied across every package at once so a consumer never has to resolve a mix. **No API changed, nothing was removed, nothing was renamed** — only what the package requires.


## [0.2.0] - 2026-07-31

### Added

- **Implements `IssueProvider`** — `listIssues`, `getIssue`, `createIssue`,
  `updateIssue`, `commentOnIssue`, against GitHub.com and GitHub Enterprise.

  **Nothing breaks.** The interface is optional and additive; existing callers
  are unaffected. Requires `@particle-academy/fancy-git` >= 0.2, where it lives.

  Two behaviours worth knowing, both tested:

  - **Pull requests are excluded from `listIssues`.** A pull request IS an issue
    in GitHub's data model and comes back from the issues endpoint carrying a
    `pull_request` key. Unfiltered, "list the open issues" answers with the open
    PRs mixed in — wrong in a way that reads as right until somebody counts.
    Pagination still follows what GitHub returned, not what survived the filter,
    so a page that happened to be all PRs does not stop the walk early.
  - **`getIssue` refuses a number that is a pull request** rather than returning
    it as an issue. Same numbering space, different thing, and handing one back
    as the other is how a workflow closes the wrong item.

  `updateIssue` sends only the keys you pass. `labels: []` clears them; an absent
  key leaves them alone.

### Changed

- `@particle-academy/fancy-git` peer widened to `>=0.2 <2.0`. **No action
  needed** — widening only adds candidates.

[0.2.0]: https://github.com/Particle-Academy/fancy-git-github-js/releases/tag/v0.2.0
