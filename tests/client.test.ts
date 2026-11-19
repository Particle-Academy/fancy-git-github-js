import { describe, expect, it } from "vitest";
import { GITHUB_API_VERSION, GitHubApiError, GitHubClient, GitHubRateLimitError, parseLinkHeader } from "../src/client.js";
import { GitHubProvider } from "../src/index.js";
import { fakeFetch } from "./support/fake-fetch.js";

const API = "https://api.github.com";
const noSleep = async () => {};

function client(fetch: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof GitHubClient>[0]> = {}) {
  return new GitHubClient({ token: "tkn", fetch, sleep: noSleep, ...extra });
}

describe("headers", () => {
  it("sends a Bearer token, GitHub's JSON media type and a pinned API version", async () => {
    const fetch = fakeFetch({ body: {} });
    await client(fetch).request("GET", "/repos/acme/app");

    expect(fetch.calls[0]!.headers).toMatchObject({
      authorization: "Bearer tkn",
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
    });
    expect(GITHUB_API_VERSION).toBe("2022-11-28");
  });

  it("omits undefined query values and JSON-encodes the body", async () => {
    const fetch = fakeFetch({ body: {} });
    await client(fetch).request("POST", "/x", { query: { a: "1", b: undefined, c: 2 }, body: { t: "y" } });

    expect(fetch.calls[0]!.url).toBe(`${API}/x?a=1&c=2`);
    expect(fetch.calls[0]!.body).toEqual({ t: "y" });
  });

  it("returns undefined data on 204", async () => {
    const fetch = fakeFetch({ status: 204 });
    const response = await client(fetch).request("DELETE", "/x");

    expect(response.status).toBe(204);
    expect(response.data).toBeUndefined();
  });
});

describe("Link header", () => {
  it("parses every relation", () => {
    expect(parseLinkHeader(`<${API}/x?page=2>; rel="next", <${API}/x?page=9>; rel="last"`)).toEqual({
      next: `${API}/x?page=2`,
      last: `${API}/x?page=9`,
    });
    expect(parseLinkHeader(null)).toEqual({});
  });

  it("keeps the RFC 8288 forms GitHub sends", () => {
    expect(parseLinkHeader(`<${API}/x?page=1>;rel="prev first" , <${API}/x?page=3> ;  rel="next"`)).toEqual({
      prev: `${API}/x?page=1`,
      first: `${API}/x?page=1`,
      next: `${API}/x?page=3`,
    });
    expect(parseLinkHeader(`<${API}/x?page=2>; type="text/html"`)).toEqual({});
    expect(parseLinkHeader(`<${API}/x?page=2>; rel=""`)).toEqual({});
    expect(parseLinkHeader(`no angle brackets; rel="next"`)).toEqual({});
    expect(parseLinkHeader(`<>; rel="next"`)).toEqual({});
  });

  it("parses a pathological header in linear time (CodeQL js/polynomial-redos)", () => {
    // '<' followed by many '<=' made the old /<([^>]+)>\s*;\s*rel="([^"]+)"/ backtrack quadratically.
    // The 100k cases are over the 8 KB cap; the ~8 KB ones prove the parser itself is linear, cap aside.
    const hostile = [
      `<${"<=".repeat(50_000)}`,
      `<${"a".repeat(100_000)}`,
      `<a>${" ".repeat(100_000)}x`,
      `<${"<=".repeat(4_000)}`,
      `<a>${"; rel=".repeat(1_300)}`,
      `<a>; rel="${" ".repeat(8_000)}`,
    ];
    for (const header of hostile) {
      const started = performance.now();
      // Over the cap it is refused (tests/contract-errors.test.ts); under it, parsed to nothing.
      if (header.length > 8 * 1024) expect(() => parseLinkHeader(header)).toThrow();
      else expect(parseLinkHeader(header)).toEqual({});
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("refuses a Link header beyond 8 KB rather than parsing all of it, or ignoring it", () => {
    const padding = `<${API}/pad>; rel="pad", `.repeat(400);
    expect(padding.length).toBeGreaterThan(8 * 1024);
    expect(() => parseLinkHeader(`${padding}<${API}/x?page=2>; rel="next"`)).toThrow(/longer than 8192/);
  });

  it("surfaces the links on the response", async () => {
    const fetch = fakeFetch({ body: [], headers: { link: `<${API}/x?page=2>; rel="next"` } });
    const response = await client(fetch).request("GET", "/x");

    expect(response.links.next).toBe(`${API}/x?page=2`);
  });
});

describe("errors", () => {
  it("carries status, GitHub's message, the request id and the docs URL", async () => {
    const fetch = fakeFetch({
      status: 404,
      body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
      headers: { "x-github-request-id": "ABCD:1234" },
    });
    const error = await client(fetch).request("GET", "/repos/acme/nope").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status: 404,
      githubMessage: "Not Found",
      requestId: "ABCD:1234",
      documentationUrl: "https://docs.github.com/rest",
      method: "GET",
    });
    expect((error as Error).message).toContain("Not Found");
    expect((error as Error).message).toContain("ABCD:1234");
  });

  it("keeps a validation failure's field errors", async () => {
    const errors = [{ resource: "Issue", code: "missing_field", field: "title" }];
    const fetch = fakeFetch({ status: 422, body: { message: "Validation Failed", errors } });
    const error = await client(fetch).request("POST", "/x", { body: {} }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 422, errors });
  });

  it("does not retry a 4xx", async () => {
    const fetch = fakeFetch({ status: 404, body: { message: "Not Found" } });
    await expect(client(fetch).request("GET", "/x")).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("rate limits", () => {
  it("surfaces the rate-limit headers on every response", async () => {
    const fetch = fakeFetch({
      body: {},
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-used": "1", "x-ratelimit-reset": "1800000000", "x-ratelimit-resource": "core" },
    });
    const response = await client(fetch).request("GET", "/x");

    expect(response.rateLimit).toEqual({ limit: 5000, remaining: 4999, used: 1, resetAt: new Date(1800000000 * 1000), resource: "core" });
  });

  it("throws a typed error when the quota is spent and the reset is too far away to wait for", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fetch = fakeFetch({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    const error = await client(fetch).request("GET", "/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect(error).toMatchObject({ status: 403, rateLimit: { limit: 60, remaining: 0, resetAt: new Date(reset * 1000) } });
    expect((error as GitHubRateLimitError).retryAfter).toBeGreaterThan(3000);
    expect(fetch.calls).toHaveLength(1);
  });

  it("waits out a short Retry-After once, then succeeds", async () => {
    const slept: number[] = [];
    const fetch = fakeFetch({ status: 429, body: { message: "slow down" }, headers: { "retry-after": "2" } }, { body: { ok: true } });
    const response = await client(fetch, { sleep: async (ms) => void slept.push(ms) }).request("POST", "/x", { body: {} });

    expect(response.data).toEqual({ ok: true });
    expect(slept).toEqual([2000]);
  });

  it("retries a rate limit only once", async () => {
    const limited = { status: 403, body: { message: "You have exceeded a secondary rate limit" }, headers: { "retry-after": "1" } };
    const fetch = fakeFetch(limited, limited);
    await expect(client(fetch).request("GET", "/x")).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("server errors", () => {
  it("retries an idempotent request on 5xx", async () => {
    const fetch = fakeFetch({ status: 502, body: { message: "Bad Gateway" } }, { status: 503, body: {} }, { body: { ok: 1 } });
    const response = await client(fetch).request("GET", "/x");

    expect(response.data).toEqual({ ok: 1 });
    expect(fetch.calls).toHaveLength(3);
  });

  it("gives up after the configured retries", async () => {
    const fetch = fakeFetch({ status: 500, body: {} }, { status: 500, body: {} });
    await expect(client(fetch, { retries: 1 }).request("GET", "/x")).rejects.toMatchObject({ status: 500 });
    expect(fetch.calls).toHaveLength(2);
  });

  it("never retries a POST, which could create the thing twice", async () => {
    const fetch = fakeFetch({ status: 502, body: { message: "Bad Gateway" } });
    await expect(client(fetch).request("POST", "/x", { body: {} })).rejects.toMatchObject({ status: 502 });
    expect(fetch.calls).toHaveLength(1);
  });

  it("wraps a network failure in a GitHubApiError with status 0", async () => {
    const failing = Object.assign(async () => {
      throw new TypeError("fetch failed");
    }, { calls: [] }) as unknown as ReturnType<typeof fakeFetch>;
    const error = await client(failing, { retries: 0 }).request("GET", "/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 0 });
  });
});

describe("provider options", () => {
  it("accepts a GitHubClient of your own", async () => {
    const fetch = fakeFetch({ body: { id: 1, html_url: "h", default_branch: "main", private: false } });
    await new GitHubProvider({ client: client(fetch) }).repository({ provider: "github", owner: "a", name: "b" });

    expect(fetch.calls[0]!.url).toBe(`${API}/repos/a/b`);
  });

  it("trims trailing slashes from baseUrl", () => {
    expect(new GitHubClient({ baseUrl: "https://ghe.example.com/api/v3///" }).baseUrl).toBe("https://ghe.example.com/api/v3");
    expect(new GitHubClient({ baseUrl: "https://ghe.example.com/api/v3" }).baseUrl).toBe("https://ghe.example.com/api/v3");
    expect(new GitHubClient().baseUrl).toBe(API);
  });

  it("trims a pathological baseUrl in linear time (CodeQL js/polynomial-redos)", () => {
    // Many '/' not at the end made the old /\/+$/ retry from every slash.
    const started = performance.now();
    const c = new GitHubClient({ baseUrl: `https://h${"/".repeat(100_000)}x` });
    expect(performance.now() - started).toBeLessThan(50);
    expect(c.baseUrl.endsWith("/x")).toBe(true);
  });

  it("refuses an Octokit instance with a message that says what to pass instead", () => {
    const octokitLike = { rest: {}, request: () => {} };
    expect(() => new GitHubProvider({ client: octokitLike as never })).toThrow(/no longer accepts an Octokit instance.*GitHubClient/i);
  });
});

describe("pagination follows the Link header", () => {
  it("does not offer a next page when GitHub says there is none, even on a full page", async () => {
    // GitHub omits rel="next" on the last page. Guessing from the page length
    // alone sends the caller to fetch an empty page that does not exist.
    const fetch = fakeFetch({ body: [{ id: 1, number: 1, title: "t", state: "open", html_url: "h", user: null, labels: [], assignees: [] }], headers: { link: `<${API}/x?page=1>; rel="first"` } });
    const page = await new GitHubProvider({ fetch }).listIssues({ provider: "github", owner: "a", name: "b" }, { limit: 1 });

    expect(page.nextCursor).toBeUndefined();
  });

  it("takes the next page number from rel=next", async () => {
    const fetch = fakeFetch({ body: [], headers: { link: `<${API}/x?per_page=2&page=4>; rel="next"` } });
    const page = await new GitHubProvider({ fetch }).listReviews({ provider: "github", owner: "a", name: "b" }, { limit: 2, cursor: "3" });

    expect(page.nextCursor).toBe("4");
  });
});
