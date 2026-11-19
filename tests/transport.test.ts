import { describe, expect, it } from "vitest";
import { fakeFetch } from "./support/fake-fetch.js";
import { makeProvider } from "./support/make-provider.js";

/**
 * What every provider operation puts on the wire: URL, method, headers, body.
 *
 * These were recorded against the Octokit-backed adapter BEFORE the first-party
 * client replaced it, and they are deliberately transport-agnostic: they talk
 * only to a fake `fetch`, so they hold the replacement to the old behaviour.
 */

const API = "https://api.github.com";
const REF = { provider: "github" as const, owner: "acme", name: "app" };

const pull = (over: Record<string, unknown> = {}) => ({
  id: 11,
  number: 5,
  title: "Add thing",
  state: "open",
  draft: false,
  merged: false,
  html_url: "https://github.com/acme/app/pull/5",
  head: { ref: "feature" },
  base: { ref: "main" },
  user: { login: "ada" },
  body: "why",
  mergeable: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  ...over,
});

const issue = (over: Record<string, unknown> = {}) => ({
  id: 100,
  number: 7,
  title: "Broken",
  state: "open",
  html_url: "https://github.com/acme/app/issues/7",
  user: { login: "ada" },
  labels: [{ name: "bug" }],
  assignees: [{ login: "grace" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  ...over,
});

function query(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

function path(url: string): string {
  return new URL(url).pathname;
}

describe("every request", () => {
  it("authenticates with the token and asks for GitHub's JSON media type", async () => {
    const fetch = fakeFetch({ body: { id: 1, html_url: "h", default_branch: "main", private: false } });
    await makeProvider(fetch, { token: "tkn" }).repository(REF);

    const headers = fetch.calls[0]!.headers;
    expect(headers.authorization).toMatch(/^(token|bearer) tkn$/i);
    expect(headers.accept).toMatch(/^application\/vnd\.github/);
    expect(headers["user-agent"]).toBeTruthy();
  });

  it("sends no authorization header when there is no token", async () => {
    const fetch = fakeFetch({ body: { id: 1, html_url: "h", default_branch: "main", private: false } });
    await makeProvider(fetch).repository(REF);

    expect(fetch.calls[0]!.headers).not.toHaveProperty("authorization");
  });

  it("goes to the Enterprise base URL, keeping its /api/v3 prefix", async () => {
    const fetch = fakeFetch({ body: { id: 1, html_url: "h", default_branch: "main", private: false } });
    await makeProvider(fetch, { baseUrl: "https://ghe.example.com/api/v3/" }).repository(REF);

    expect(fetch.calls[0]!.url).toBe("https://ghe.example.com/api/v3/repos/acme/app");
  });

  it("encodes path segments rather than letting them change the path", async () => {
    const fetch = fakeFetch({ body: { check_runs: [] } }, { body: { statuses: [] } });
    await makeProvider(fetch).checks(REF, "feature/x");

    const urls = fetch.calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      `${API}/repos/acme/app/commits/feature%2Fx/check-runs`,
      `${API}/repos/acme/app/commits/feature%2Fx/status`,
    ]);
  });
});

describe("repository", () => {
  it("GETs the repo and normalizes it", async () => {
    const fetch = fakeFetch({ body: { id: 9, html_url: "https://github.com/acme/app", default_branch: "trunk", private: true, description: null } });
    const repo = await makeProvider(fetch).repository(REF);

    expect(fetch.calls[0]).toMatchObject({ method: "GET", url: `${API}/repos/acme/app`, body: undefined });
    expect(repo).toEqual({ provider: "github", owner: "acme", name: "app", id: "9", webUrl: "https://github.com/acme/app", defaultBranch: "trunk", private: true, description: undefined });
  });
});

describe("listReviews", () => {
  it("lists pulls with state, page and per_page", async () => {
    const fetch = fakeFetch({ body: [pull()] });
    const page = await makeProvider(fetch).listReviews(REF, { state: "merged", limit: 10, cursor: "3" });

    const call = fetch.calls[0]!;
    expect(call.method).toBe("GET");
    expect(path(call.url)).toBe("/repos/acme/app/pulls");
    expect(query(call.url)).toEqual({ state: "closed", page: "3", per_page: "10" });
    expect(page.items[0]).toEqual({ id: "11", number: 5, title: "Add thing", state: "open", webUrl: "https://github.com/acme/app/pull/5", sourceBranch: "feature", targetBranch: "main", author: "ada" });
    expect(page.nextCursor).toBeUndefined();
  });

  it("defaults to every state, page 1, 30 per page", async () => {
    const fetch = fakeFetch({ body: [] });
    await makeProvider(fetch).listReviews(REF);

    expect(query(fetch.calls[0]!.url)).toEqual({ state: "all", page: "1", per_page: "30" });
  });
});

describe("getReview", () => {
  it("GETs one pull with its detail fields", async () => {
    const fetch = fakeFetch({ body: pull({ merged: true, state: "closed" }) });
    const review = await makeProvider(fetch).getReview(REF, 5);

    expect(fetch.calls[0]).toMatchObject({ method: "GET", url: `${API}/repos/acme/app/pulls/5` });
    expect(review).toMatchObject({ state: "merged", body: "why", mergeable: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" });
  });
});

describe("createReview", () => {
  it("POSTs head/base/title/body/draft", async () => {
    const fetch = fakeFetch({ status: 201, body: pull({ draft: true }) });
    const review = await makeProvider(fetch).createReview(REF, { title: "Add thing", body: "why", sourceBranch: "feature", targetBranch: "main", draft: true });

    const call = fetch.calls[0]!;
    expect(call).toMatchObject({ method: "POST", url: `${API}/repos/acme/app/pulls` });
    expect(call.headers["content-type"]).toMatch(/^application\/json/);
    expect(call.body).toEqual({ title: "Add thing", body: "why", head: "feature", base: "main", draft: true });
    expect(review.state).toBe("draft");
  });
});

describe("compare", () => {
  it("GETs base...head and maps the commits", async () => {
    const fetch = fakeFetch({
      body: {
        ahead_by: 2,
        behind_by: 1,
        html_url: "https://github.com/acme/app/compare/main...feature",
        commits: [
          { sha: "abcdef1234567", parents: [{ sha: "p1" }], author: { login: "ada" }, commit: { author: { name: "Ada", email: "ada@example.com", date: "2026-01-01T00:00:00Z" }, message: "subject\n\nbody" } },
        ],
      },
    });
    const comparison = await makeProvider(fetch).compare(REF, "main", "feature/x");

    expect(fetch.calls[0]).toMatchObject({ method: "GET", url: `${API}/repos/acme/app/compare/main...feature%2Fx` });
    expect(comparison).toEqual({
      aheadBy: 2,
      behindBy: 1,
      commits: [{ id: "abcdef1234567", shortId: "abcdef1", parents: ["p1"], authorName: "Ada", authorEmail: "ada@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "subject" }],
      patchUrl: "https://github.com/acme/app/compare/main...feature.diff",
    });
  });
});

describe("checks", () => {
  it("merges check runs and commit statuses", async () => {
    const fetch = fakeFetch(
      { body: { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", html_url: "r", started_at: "s", completed_at: "c" }] } },
      { body: { statuses: [{ id: 2, context: "legacy", state: "pending", target_url: null }] } },
    );
    const checks = await makeProvider(fetch).checks(REF, "abc");

    expect(fetch.calls.every((c) => c.method === "GET")).toBe(true);
    expect(checks).toEqual([
      { id: "1", name: "ci", state: "passed", webUrl: "r", startedAt: "s", completedAt: "c" },
      { id: "2", name: "legacy", state: "queued", webUrl: undefined },
    ]);
  });
});

describe("issues", () => {
  it("listIssues GETs with state, page, per_page, labels and assignee", async () => {
    const fetch = fakeFetch({ body: [issue()] });
    await makeProvider(fetch).listIssues(REF, { state: "closed", labels: ["bug", "p1"], assignee: "ada", limit: 5, cursor: "2" });

    const call = fetch.calls[0]!;
    expect(call.method).toBe("GET");
    expect(path(call.url)).toBe("/repos/acme/app/issues");
    expect(query(call.url)).toEqual({ state: "closed", page: "2", per_page: "5", labels: "bug,p1", assignee: "ada" });
  });

  it("listIssues leaves labels and assignee off when not given", async () => {
    const fetch = fakeFetch({ body: [] });
    await makeProvider(fetch).listIssues(REF);

    expect(query(fetch.calls[0]!.url)).toEqual({ state: "open", page: "1", per_page: "30" });
  });

  it("getIssue GETs the number", async () => {
    const fetch = fakeFetch({ body: issue({ body: "steps", comments: 2, closed_at: "2026-02-01T00:00:00Z" }) });
    const details = await makeProvider(fetch).getIssue(REF, 7);

    expect(fetch.calls[0]).toMatchObject({ method: "GET", url: `${API}/repos/acme/app/issues/7` });
    expect(details).toMatchObject({ body: "steps", commentCount: 2, closedAt: "2026-02-01T00:00:00Z" });
  });

  it("createIssue POSTs only the fields given", async () => {
    const fetch = fakeFetch({ status: 201, body: issue() });
    await makeProvider(fetch).createIssue(REF, { title: "Broken", labels: ["bug"], assignees: ["grace"] });

    expect(fetch.calls[0]).toMatchObject({ method: "POST", url: `${API}/repos/acme/app/issues`, body: { title: "Broken", labels: ["bug"], assignees: ["grace"] } });
  });

  it("updateIssue PATCHes only the fields given, and keeps an empty labels list", async () => {
    const fetch = fakeFetch({ body: issue({ state: "closed", labels: [] }) });
    await makeProvider(fetch).updateIssue(REF, 7, { state: "closed", labels: [] });

    expect(fetch.calls[0]).toMatchObject({ method: "PATCH", url: `${API}/repos/acme/app/issues/7`, body: { state: "closed", labels: [] } });
  });

  it("commentOnIssue POSTs the body to the comments endpoint", async () => {
    const fetch = fakeFetch({ status: 201, body: { id: 55, html_url: "https://github.com/acme/app/issues/7#c55" } });
    const comment = await makeProvider(fetch).commentOnIssue(REF, 7, "hello");

    expect(fetch.calls[0]).toMatchObject({ method: "POST", url: `${API}/repos/acme/app/issues/7/comments`, body: { body: "hello" } });
    expect(comment).toEqual({ id: "55", webUrl: "https://github.com/acme/app/issues/7#c55" });
  });
});

describe("pagination", () => {
  /** Walk every page the way a caller does: follow nextCursor until it stops. */
  async function walk(fetch: ReturnType<typeof fakeFetch>) {
    const provider = makeProvider(fetch);
    const numbers: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await provider.listIssues(REF, { limit: 2, cursor });
      numbers.push(...page.items.map((i) => i.number));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    return numbers;
  }

  it("reaches every page, not just the first", async () => {
    const link = (next: number, last: number) =>
      `<${API}/repositories/1/issues?state=open&per_page=2&page=${next}>; rel="next", <${API}/repositories/1/issues?state=open&per_page=2&page=${last}>; rel="last"`;
    const fetch = fakeFetch(
      { body: [issue({ number: 1 }), issue({ number: 2 })], headers: { link: link(2, 3) } },
      { body: [issue({ number: 3 }), issue({ number: 4 })], headers: { link: link(3, 3) } },
      { body: [issue({ number: 5 })] },
    );

    expect(await walk(fetch)).toEqual([1, 2, 3, 4, 5]);
    expect(fetch.calls.map((c) => query(c.url).page)).toEqual(["1", "2", "3"]);
  });

  it("stops on a short page", async () => {
    const fetch = fakeFetch({ body: [issue({ number: 1 })] });
    const page = await makeProvider(fetch).listIssues(REF, { limit: 2 });

    expect(page.nextCursor).toBeUndefined();
  });
});

describe("errors", () => {
  it("rejects with GitHub's status and message", async () => {
    const fetch = fakeFetch({ status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" }, headers: { "x-github-request-id": "ABCD:1234" } });

    await expect(makeProvider(fetch).repository(REF)).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Not Found") });
  });

  it("rejects a validation failure with 422", async () => {
    const fetch = fakeFetch({ status: 422, body: { message: "Validation Failed", errors: [{ resource: "Issue", code: "missing_field", field: "title" }] } });

    await expect(makeProvider(fetch).createIssue(REF, { title: "" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Validation Failed") });
  });
});
