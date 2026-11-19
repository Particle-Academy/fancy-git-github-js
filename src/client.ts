/**
 * A minimal first-party GitHub REST client over global `fetch` (Node >= 22).
 *
 * It does exactly what the adapter needs and no more: auth, GitHub's media type
 * and a pinned API version, JSON in and out, Link-header parsing, typed errors,
 * rate-limit headers on every response, and a small retry policy. It replaced
 * the `octokit` dependency, so the retry policy keeps the two behaviours of
 * Octokit's defaults that a caller would notice losing (see `request`).
 */

import { GitError } from "@particle-academy/fancy-git";
import type { GitErrorCode } from "@particle-academy/fancy-git";

/** The REST API version every request pins. */
export const GITHUB_API_VERSION = "2022-11-28";

const DEFAULT_BASE_URL = "https://api.github.com";
const USER_AGENT = "@particle-academy/fancy-git-github";
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"]);
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RateLimit {
  limit?: number;
  remaining?: number;
  used?: number;
  resetAt?: Date;
  resource?: string;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  /** Relations from the `Link` header, e.g. `links.next`. */
  links: Record<string, string>;
  rateLimit: RateLimit;
  requestId?: string;
}

export interface GitHubClientOptions {
  token?: string;
  /** `https://api.github.com` by default; Enterprise is `https://<host>/api/v3`. */
  baseUrl?: string;
  /** Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Retries for an idempotent request that hit a 5xx or a network failure. Default 3. */
  retries?: number;
  /** Longest rate-limit wait, in seconds, that is waited out rather than thrown. Default 60. */
  maxRetryAfter?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * The fancy-git contract code for a GitHub HTTP status, the same table the
 * GitLab and Bitbucket adapters use. A rate limit is `rate_limited` whatever
 * its status (GitHub sends a spent primary quota as a 403).
 */
export function errorCodeFor(status: number, rateLimited = false): GitErrorCode {
  if (rateLimited || status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 405) return "unsupported";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid_argument";
  return "unknown";
}

/**
 * A failed GitHub request. It is a fancy-git `GitError`, so `code` carries the
 * contract code (`auth`, `not_found`, `rate_limited`, ...) and `exitCode` the
 * HTTP status, and a caller can catch every adapter's failures the same way.
 */
export class GitHubApiError extends GitError {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  /** GitHub's own `message`, unadorned. */
  readonly githubMessage?: string;
  readonly documentationUrl?: string;
  readonly errors?: unknown[];
  readonly requestId?: string;
  readonly rateLimit: RateLimit;

  constructor(init: {
    status: number;
    method: string;
    url: string;
    githubMessage?: string;
    documentationUrl?: string;
    errors?: unknown[];
    requestId?: string;
    rateLimit?: RateLimit;
    cause?: unknown;
  }, rateLimited = false) {
    const what = init.githubMessage ?? (init.status === 0 ? "network error" : `HTTP ${init.status}`);
    super(
      errorCodeFor(init.status, rateLimited),
      `GitHub API ${init.status} ${init.method} ${init.url}: ${what}${init.requestId ? ` (request ${init.requestId})` : ""}`,
      init.status === 0 ? undefined : init.status,
    );
    if (init.cause !== undefined) Object.defineProperty(this, "cause", { value: init.cause, enumerable: false, writable: true, configurable: true });
    this.name = "GitHubApiError";
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.githubMessage = init.githubMessage;
    this.documentationUrl = init.documentationUrl;
    this.errors = init.errors;
    this.requestId = init.requestId;
    this.rateLimit = init.rateLimit ?? {};
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  /** Seconds until a retry may succeed, when GitHub said or the reset implies it. */
  readonly retryAfter?: number;

  constructor(init: ConstructorParameters<typeof GitHubApiError>[0] & { retryAfter?: number }) {
    super(init, true);
    this.name = "GitHubRateLimitError";
    this.retryAfter = init.retryAfter;
  }
}

/**
 * Longest `Link` header parsed. GitHub's are a few hundred bytes. A longer one
 * is refused with a `GitError`, so a hostile or broken server cannot make the
 * client do unbounded work: refused, not ignored, because ignoring it ends a
 * paginated walk early with a list that reads as complete.
 */
export const MAX_LINK_HEADER_LENGTH = 8 * 1024;

/**
 * Parse an RFC 8288 `Link` header into `{ rel: url }`.
 *
 * Linear by construction: indexOf / slice / split only, no backtracking regex.
 * The header comes from whatever server `baseUrl` points at, so it is
 * untrusted input (CodeQL js/polynomial-redos flagged the regex this replaced).
 */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  if (header.length > MAX_LINK_HEADER_LENGTH) {
    throw new GitError("unknown", `GitHub sent a pagination Link header longer than ${MAX_LINK_HEADER_LENGTH} characters. It was not parsed, and the page was not returned, because the list may be incomplete.`);
  }
  for (const part of header.split(",")) {
    const open = part.indexOf("<");
    if (open === -1) continue;
    const close = part.indexOf(">", open + 1);
    if (close <= open + 1) continue;
    const url = part.slice(open + 1, close);
    for (const param of part.slice(close + 1).split(";")) {
      const eq = param.indexOf("=");
      if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== "rel") continue;
      const value = param.slice(eq + 1).trim();
      const end = value.indexOf('"', 1);
      if (value[0] !== '"' || end <= 1) break;
      for (const rel of value.slice(1, end).split(/\s+/)) {
        if (rel) links[rel] = url;
      }
      break;
    }
  }
  return links;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return value.slice(0, end);
}

function intHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function rateLimitFrom(headers: Headers): RateLimit {
  const reset = intHeader(headers, "x-ratelimit-reset");
  const resource = headers.get("x-ratelimit-resource") ?? undefined;
  const limit: RateLimit = {
    limit: intHeader(headers, "x-ratelimit-limit"),
    remaining: intHeader(headers, "x-ratelimit-remaining"),
    used: intHeader(headers, "x-ratelimit-used"),
    resetAt: reset === undefined ? undefined : new Date(reset * 1000),
    resource,
  };
  return Object.fromEntries(Object.entries(limit).filter(([, v]) => v !== undefined)) as RateLimit;
}

/**
 * Build a path with every interpolated value URL-encoded, so an owner, repo or
 * ref can never change the shape of the path (`feature/x` becomes `feature%2Fx`).
 */
export function path(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(String(values[i])) : ""), "");
}

export class GitHubClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly maxRetryAfter: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.retries = options.retries ?? 3;
    this.maxRetryAfter = options.maxRetryAfter ?? 60;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Send one request.
   *
   * Retry policy, kept from Octokit's defaults where a caller would notice:
   * - a rate limit (429, or 403 with no quota left / a Retry-After / a
   *   secondary-limit message) is retried ONCE when the wait is at most
   *   `maxRetryAfter` seconds, otherwise thrown as `GitHubRateLimitError`;
   * - a 5xx or network failure is retried up to `retries` times with backoff,
   *   but only for idempotent methods. A POST is never replayed, because a
   *   gateway error can arrive after GitHub already created the thing.
   */
  async request<T = unknown>(method: HttpMethod, route: string, options: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = new URL(this.baseUrl + route);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": USER_AGENT,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(options.body);
    }

    const idempotent = IDEMPOTENT.has(method);
    let serverRetries = 0;
    let rateLimitRetried = false;

    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), { method, headers, body });
      } catch (cause) {
        if (idempotent && serverRetries < this.retries) {
          await this.sleep(this.backoff(serverRetries++));
          continue;
        }
        throw new GitHubApiError({ status: 0, method, url: url.toString(), cause });
      }

      const rateLimit = rateLimitFrom(response.headers);
      const requestId = response.headers.get("x-github-request-id") ?? undefined;
      const data = await this.parse(response);

      if (response.ok) {
        return { status: response.status, data: data as T, headers: response.headers, links: parseLinkHeader(response.headers.get("link")), rateLimit, requestId };
      }

      const payload = (data && typeof data === "object" ? data : {}) as { message?: string; documentation_url?: string; errors?: unknown[] };
      const init = {
        status: response.status,
        method,
        url: url.toString(),
        githubMessage: payload.message ?? (typeof data === "string" && data ? data : undefined),
        documentationUrl: payload.documentation_url,
        errors: payload.errors,
        requestId,
        rateLimit,
      };

      const retryAfter = this.rateLimitWait(response, rateLimit, payload.message);
      if (retryAfter !== null) {
        if (!rateLimitRetried && retryAfter !== undefined && retryAfter <= this.maxRetryAfter) {
          rateLimitRetried = true;
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new GitHubRateLimitError({ ...init, retryAfter });
      }

      if (idempotent && RETRYABLE_STATUS.has(response.status) && serverRetries < this.retries) {
        const hinted = intHeader(response.headers, "retry-after");
        await this.sleep(hinted !== undefined ? hinted * 1000 : this.backoff(serverRetries));
        serverRetries++;
        continue;
      }

      throw new GitHubApiError(init);
    }
  }

  get<T = unknown>(route: string, query?: RequestOptions["query"]): Promise<GitHubResponse<T>> {
    return this.request<T>("GET", route, { query });
  }

  post<T = unknown>(route: string, body: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>("POST", route, { body });
  }

  patch<T = unknown>(route: string, body: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>("PATCH", route, { body });
  }

  private backoff(attempt: number): number {
    return 500 * 2 ** attempt;
  }

  private async parse(response: Response): Promise<unknown> {
    if (response.status === 204 || response.status === 304) return undefined;
    const text = await response.text();
    if (text === "") return undefined;
    if (/json/i.test(response.headers.get("content-type") ?? "")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  /**
   * `null` when the response is not a rate limit; otherwise the seconds to wait
   * (or `undefined` when GitHub gave nothing to compute one from).
   */
  private rateLimitWait(response: Response, rateLimit: RateLimit, message: string | undefined): number | undefined | null {
    const retryAfter = intHeader(response.headers, "retry-after");
    const exhausted = rateLimit.remaining === 0;
    const secondary = /secondary rate limit/i.test(message ?? "");
    const isLimit = response.status === 429 || (response.status === 403 && (exhausted || retryAfter !== undefined || secondary));
    if (!isLimit) return null;
    if (retryAfter !== undefined) return retryAfter;
    if (exhausted && rateLimit.resetAt) return Math.max(0, Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000));
    return undefined;
  }
}
