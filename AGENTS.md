# Using @particle-academy/fancy-git-github — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-git @particle-academy/fancy-git-github
```

- `@particle-academy/fancy-git` is a **peer** (`>=0.2 <2.0`); install it too.
- Runtime dependency: `octokit` `^5`. **Node:** `>=22`.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). This package is the registry entry
`fancy-git-github-js`. Server-side packages are found with
`search-backend-packages` (stack `node`); `install-instructions` gives the exact
commands for the slug.

## API essentials

```ts
import { ProviderRegistry } from "@particle-academy/fancy-git";
import { GitHubProvider } from "@particle-academy/fancy-git-github";

const github = new GitHubProvider({ token: process.env.GITHUB_TOKEN });
const enterprise = new GitHubProvider({ token, baseUrl: "https://ghe.example.com/api/v3" });
const providers = new ProviderRegistry().register(github);
```

- `GitHubProviderOptions`: `token`, `baseUrl` (defaults to
  `https://api.github.com`), or `client` (your own `Octokit` instance).
- `GitHubProvider` implements fancy-git's `GitProvider` (`kind` is `"github"`):
  `identify`, `repository`, `listReviews`, `getReview`, `createReview`,
  `compare`, `checks`. It also implements `IssueProvider`: `listIssues`,
  `getIssue`, `createIssue`, `updateIssue`, `commentOnIssue`.
- `identify(remote)` matches `github.com` remotes for the default base URL, or
  the Enterprise host of `baseUrl` otherwise; any other host returns `null`.

## Traps

- **`listIssues` pages can hold fewer items than `limit`.** GitHub's issues
  endpoint returns pull requests too; this adapter filters them out, but
  paginates on what GitHub returned. Keep following `nextCursor` rather than
  stopping on a short page.
