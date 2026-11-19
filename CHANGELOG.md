# Changelog

All notable changes to `@particle-academy/fancy-git-github` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0: breaking changes land in MINOR releases.** Read the entry, not the
> version number.

## [Unreleased]

## [0.4.0] — 2026-11-19

### Changed

- **BREAKING (only if you passed `client`): octokit is removed; the adapter
  talks to GitHub through its own small client on global `fetch`.** The
  `GitHubProviderOptions.client` option now takes a `GitHubClient` (exported
  from this package) instead of an `Octokit` instance.
  - **If you construct `new GitHubProvider({ token })` or `{ token, baseUrl }`,
    do nothing.** Every operation sends the same requests to the same endpoints
    and returns the same shapes, and the GitHub Enterprise base URL
    (`https://<host>/api/v3`) is still supported.
  - **If you passed `client: new Octokit(...)`**, pass `{ token, baseUrl }`
    instead, or `client: new GitHubClient({ token, baseUrl })`. Passing an
    Octokit instance now throws a `TypeError` that says so, rather than failing
    on the first request.
  - **If you caught Octokit's `RequestError`**, catch `GitHubApiError` instead.
    It keeps `status`, and adds GitHub's own message (`githubMessage`), the
    `requestId`, `documentationUrl`, validation `errors` and the response's
    `rateLimit`. A rate limit throws the subclass `GitHubRateLimitError` with
    `retryAfter` in seconds.
  - Requests now send `Authorization: Bearer <token>`,
    `Accept: application/vnd.github+json` and a pinned
    `X-GitHub-Api-Version: 2022-11-28`.
  - Retries follow Octokit's defaults where you would notice the difference: a
    rate limit is waited out ONCE when GitHub's wait is 60 seconds or less
    (`maxRetryAfter`), otherwise it throws; a 5xx or network failure is retried
    up to 3 times, but now only for idempotent methods. A `POST` is never
    replayed, because a gateway error can arrive after GitHub already created
    the issue or pull request.
  - Why: octokit was never approved as a dependency and fails the kit's
    three-month freshness rule for third-party code.
- CI: re-pin org third-party allowlist to 2614224

### Added

- `GitHubClient`, `GitHubApiError`, `GitHubRateLimitError`, `parseLinkHeader`
  and `GITHUB_API_VERSION` are exported, and `GitHubProviderOptions` takes a
  `fetch` to use instead of the global one (a proxy, or a test double).
- Every response carries its rate-limit headers (`limit`, `remaining`, `used`,
  `resetAt`, `resource`) and its parsed `Link` relations.

### Fixed

- **A pagination `Link` header over 8 KB now throws instead of being ignored.**
  Ignoring it ended `listReviews` / `listIssues` on the current page with no
  `nextCursor`, so a walk returned a short list that read as complete. It now
  throws a `GitError` (code `unknown`), as the GitLab adapter already did.
  `parseLinkHeader()` throws the same way for an over-cap header. GitHub's own
  headers are a few hundred bytes, so nothing to do unless you call
  `parseLinkHeader()` on headers you do not control.
- **GitHub's failures carry the fancy-git error code.** `GitHubApiError` (and
  `GitHubRateLimitError`) now extend fancy-git's `GitError`: `code` is the
  contract code (401/403 `auth`, 404 `not_found`, 400/422 `invalid_argument`,
  405 `unsupported`, 409 `conflict`, any rate limit `rate_limited`, otherwise
  `unknown`) and `exitCode` is the HTTP status. A 429 used to carry no code at
  all. Nothing to do: `status`, `githubMessage` and the subclasses are
  unchanged, and `instanceof GitHubApiError` still holds. Found by the
  fancy-labs git-adapter test.

- **`listReviews` and `listIssues` no longer offer a next page that does not
  exist.** The next cursor came from the page length alone, so a last page that
  happened to be exactly full sent the caller to fetch an empty page. It now
  follows GitHub's `Link` header (`rel="next"`), and falls back to the length
  only when there is no Link header at all. Nothing to do; a loop that follows
  `nextCursor` makes one fewer request.

- **CI: the lab-certificate gate verifies against the lab's rotated key list.**
  The lab's first signing key is retired: certificates it already issued still
  verify, and nothing new it signs ever can. Consumers do nothing.

- **Releases need a lab-run certificate.** `publish.yml` gains a read-only
  `lab-certificate` job that every publishing job needs: a tag is published only
  when the fancy-labs lab has certified that exact version and commit. Consumers
  do nothing; this changes how releases are cut, not what the package does.
- Rebranded the display name to Fancy Dev Kit (README and package description). Package names, the npm scope, URLs and the `fancy-ui` MCP id are unchanged.
- **Docs:** `AGENTS.md` added: the guide to using this package (install, its entries on the Fancy MCP catalog server, API essentials, traps), and it ships in the package. `CONTRIBUTING.md` added for the contributor notes, with `CLAUDE.md` as a symlink to it. The README points to the MCP server and to `AGENTS.md`. No code changed; nothing to do.

### Fixed

- **`CHANGELOG.md` is now in the published tarball.** `files` did not whitelist it, so npm never shipped it — and this package puts breaking changes in MINOR releases and tells you in the README to read the entry before taking one. The instruction existed for the author, who has the file, and not for the consumer, who is the only one being instructed. Nothing for you to do; the file simply arrives from this release on.

### Security

- **Two polynomial-time regexes in the new client are gone (CodeQL
  js/polynomial-redos, HIGH, alerts 1 and 2).** `parseLinkHeader` matched each
  `Link` header part with a backtracking regex, so a hostile or broken server
  at `baseUrl` could send a header that took seconds to parse (3.7 s for a
  100 KB header in the regression test); trimming trailing slashes from
  `baseUrl` had the same shape (6.7 s). Both now parse linearly with
  `indexOf`/`slice`, and a `Link` header longer than 8 KB
  (`MAX_LINK_HEADER_LENGTH`, exported) is ignored rather than parsed. Both
  regexes arrived with the octokit replacement above and were never in a
  release. **Nothing to do**: every Link header GitHub sends parses as before.
- Update Vitest to 4.1.12 for security fixes; dev toolchain only, nothing to do.

- `source-map-js` is pinned forward to `^1.2.2` via `overrides`. Versions up to
  1.2.1 allow an event-loop denial of service through indexed source-map section
  offsets, and it arrives here transitively through the build toolchain.
  **Nothing for a consumer to do, and no runtime change**: an npm package does
  not ship a lockfile, so this governs builds OF this repo, not anything
  installed FROM it. Recorded rather than left silent because the override it
  sits beside — `shell-quote` `^1.9.0`, added for an earlier advisory — was
  carried with no note of why, and had drifted back inside the vulnerable range
  before anyone looked.
- **Dev toolchain only — no runtime change, nothing for consumers to do.** The
  lockfile now resolves `vite` 8.3.5 (was 8.2.2), whose bundled
  `launch-editor` fixes GHSA-587h-7wmj-h5pm (HIGH, `fs.existsSync()` check
  bypassable on Windows), GHSA-698v-4r3x-3vcv (`escapeCmdArgs()` omits `%`
  escaping on Windows) and GHSA-r825-w8mm-5pxw (editor CLI flag
  misinterpretation). `vite` is only reached through the test/dev toolchain
  and the published package does not ship our lockfile, so the exposure was
  this repo's own dev server.

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
