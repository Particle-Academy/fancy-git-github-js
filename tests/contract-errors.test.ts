import { describe, expect, it } from "vitest";
import { GitError } from "@particle-academy/fancy-git";
import { GitHubApiError, GitHubClient, GitHubRateLimitError, MAX_LINK_HEADER_LENGTH, parseLinkHeader } from "../src/client.js";
import { GitHubProvider } from "../src/index.js";
import { fakeFetch } from "./support/fake-fetch.js";

/**
 * Found by the fancy-labs git-adapter test: GitHub's failures did not carry a
 * fancy-git error code (so a caller branching on `code` saw nothing, and a 429
 * was not `rate_limited`), and a pagination Link header over the 8 KB cap was
 * IGNORED, which ended a walk on page one with a list that read as complete.
 * The GitLab adapter already threw there; the PHP twin now does both too.
 */

const API = "https://api.github.com";
const REF = { provider: "github" as const, owner: "acme", name: "app" };
const noSleep = async () => {};

function provider(fetch: ReturnType<typeof fakeFetch>): GitHubProvider {
  return new GitHubProvider({ client: new GitHubClient({ token: "tkn", fetch, sleep: noSleep }) });
}

async function caught(call: () => Promise<unknown>): Promise<GitError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    return error as GitError;
  }
  throw new Error("Expected a GitError.");
}

describe("GitHub's failures carry the fancy-git contract code", () => {
  it.each([
    [400, {}, "invalid_argument"],
    [401, {}, "auth"],
    [403, { "x-ratelimit-remaining": "4999" }, "auth"],
    [404, {}, "not_found"],
    [405, {}, "unsupported"],
    [409, {}, "conflict"],
    [422, {}, "invalid_argument"],
    [429, { "retry-after": "120" }, "rate_limited"],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) }, "rate_limited"],
  ])("maps %i to its code", async (status, headers, code) => {
    const fetch = fakeFetch({ status, body: { message: "nope" }, headers });

    const e = await caught(() => provider(fetch).repository(REF));

    expect(e.code).toBe(code);
    expect(e.exitCode).toBe(status);
    expect(e).toBeInstanceOf(GitHubApiError);
    expect(fetch.calls).toHaveLength(1);
  });

  it("keeps the rate-limit subclass, now also a GitError", async () => {
    const fetch = fakeFetch({ status: 429, body: { message: "API rate limit exceeded" }, headers: { "retry-after": "120" } });

    const e = await caught(() => provider(fetch).repository(REF));

    expect(e).toBeInstanceOf(GitHubRateLimitError);
    expect((e as GitHubRateLimitError).retryAfter).toBe(120);
  });

  it("maps a 5xx that outlasts its retries to unknown", async () => {
    const fetch = fakeFetch(...Array.from({ length: 4 }, () => ({ status: 503, body: { message: "Service Unavailable" } })));

    const e = await caught(() => provider(fetch).repository(REF));

    expect(e.code).toBe("unknown");
    expect(e.exitCode).toBe(503);
  });

  it("maps a network failure to unknown", async () => {
    const failing = Object.assign(async () => {
      throw new TypeError("fetch failed");
    }, { calls: [] }) as unknown as ReturnType<typeof fakeFetch>;

    const e = await caught(() => new GitHubClient({ fetch: failing, retries: 0, sleep: noSleep }).get("/x"));

    expect(e.code).toBe("unknown");
  });
});

describe("a Link header over the cap is refused, never ignored", () => {
  it("throws from parseLinkHeader", () => {
    const header = `<${API}/x?page=2&pad=${"x".repeat(MAX_LINK_HEADER_LENGTH)}>; rel="next"`;

    expect(() => parseLinkHeader(header)).toThrow(GitError);
  });

  it("ends a walk with an error, not a short list that reads as complete", async () => {
    const fetch = fakeFetch(
      { body: [{ id: 1 }, { id: 2 }], headers: { link: `<${API}/repos/acme/app/pulls?page=2&pad=${"x".repeat(9000)}>; rel="next"` } },
      { body: [] },
    );

    const e = await caught(() => provider(fetch).listReviews(REF, { limit: 2 }));

    expect(e.code).toBe("unknown");
    expect(e.message).toContain("Link header");
    expect(fetch.calls).toHaveLength(1);
  });

  it("throws on a hostile 100,000-character header, quickly", async () => {
    const fetch = fakeFetch({ body: [], headers: { link: "<".repeat(100_000) } });

    const started = performance.now();
    await caught(() => provider(fetch).listReviews(REF, { limit: 2 }));
    expect(performance.now() - started).toBeLessThan(200);
  });
});
