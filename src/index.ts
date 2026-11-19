import { GitHubClient, path, type GitHubResponse } from "./client.js";
import type {
  CheckState,
  CreateIssueInput,
  Issue,
  IssueDetails,
  IssueProvider,
  IssueQuery,
  IssueState,
  UpdateIssueInput,
  CheckSummary,
  Comparison,
  CreateReviewInput,
  GitProvider,
  GitRemote,
  HostedRepository,
  Page,
  ProviderRepositoryRef,
  Review,
  ReviewDetails,
  ReviewQuery,
  ReviewState,
} from "@particle-academy/fancy-git";

export {
  GITHUB_API_VERSION,
  GitHubApiError,
  GitHubClient,
  GitHubRateLimitError,
  parseLinkHeader,
  type GitHubClientOptions,
  type GitHubResponse,
  type HttpMethod,
  type RateLimit,
  type RequestOptions,
} from "./client.js";

export interface GitHubProviderOptions {
  token?: string;
  /** `https://api.github.com` by default; Enterprise is `https://<host>/api/v3`. */
  baseUrl?: string;
  /** Your own configured client. Takes precedence over `token` and `fetch`. */
  client?: GitHubClient;
  /** A `fetch` to use instead of the global one (proxies, tests). */
  fetch?: typeof globalThis.fetch;
}

/**
 * The next cursor for a page-numbered list. GitHub's `Link` header is the
 * authority when present: no `rel="next"` means there is no next page, even
 * when this page came back full. Only without a Link header at all does the
 * page length decide.
 */
function nextCursor(response: GitHubResponse<unknown[]>, page: number, perPage: number): string | undefined {
  if (response.headers.has("link")) {
    const next = response.links.next;
    if (!next) return undefined;
    return new URL(next).searchParams.get("page") ?? String(page + 1);
  }
  return response.data.length === perPage ? String(page + 1) : undefined;
}

function parseRemote(url: string): { host: string; owner: string; name: string } | null {
  const match = url.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : null;
}

function reviewState(value: string, draft?: boolean, merged?: boolean): ReviewState {
  if (merged) return "merged";
  if (draft) return "draft";
  return value === "open" ? "open" : "closed";
}

function checkState(status: string | null, conclusion: string | null): CheckState {
  if (status === "queued" || status === "pending") return "queued";
  if (status === "in_progress") return "running";
  if (conclusion === "success" || conclusion === "neutral") return "passed";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "skipped") return "skipped";
  if (conclusion) return "failed";
  return "unknown";
}

export class GitHubProvider implements GitProvider, IssueProvider {
  readonly kind = "github" as const;
  private readonly baseUrl: string;
  private readonly client: GitHubClient;

  constructor(options: GitHubProviderOptions = {}) {
    const given = options.client as unknown;
    if (given && typeof given === "object" && "rest" in given) {
      throw new TypeError(
        "GitHubProvider no longer accepts an Octokit instance: octokit was removed. Pass { token, baseUrl }, or { client: new GitHubClient({ token, baseUrl }) } from @particle-academy/fancy-git-github.",
      );
    }
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? options.client?.baseUrl ?? "https://api.github.com";
    this.client = options.client ?? new GitHubClient({ token: options.token, baseUrl: this.baseUrl, fetch: options.fetch });
  }

  identify(remote: GitRemote): ProviderRepositoryRef | null {
    const parsed = parseRemote(remote.fetchUrl);
    if (!parsed) return null;
    const expectedHost = new URL(this.baseUrl).hostname === "api.github.com"
      ? "github.com"
      : new URL(this.baseUrl).hostname;
    if (parsed.host !== expectedHost) return null;
    return { provider: this.kind, owner: parsed.owner, name: parsed.name, ...(this.baseUrl === "https://api.github.com" ? {} : { baseUrl: this.baseUrl }) };
  }

  async repository(ref: ProviderRepositoryRef): Promise<HostedRepository> {
    const { data } = await this.client.get<any>(path`/repos/${ref.owner}/${ref.name}`);
    return { provider: this.kind, owner: ref.owner, name: ref.name, id: String(data.id), webUrl: data.html_url, defaultBranch: data.default_branch, private: data.private, description: data.description ?? undefined, ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}) };
  }

  async listReviews(ref: ProviderRepositoryRef, query: ReviewQuery = {}): Promise<Page<Review>> {
    const state = query.state === "merged" || query.state === "closed" ? "closed" : query.state === "open" || query.state === "draft" ? "open" : "all";
    const page = Number(query.cursor ?? "1");
    const perPage = query.limit ?? 30;
    const response = await this.client.get<any[]>(path`/repos/${ref.owner}/${ref.name}/pulls`, { state, page, per_page: perPage });
    const next = nextCursor(response, page, perPage);
    return { items: response.data.map((item) => this.mapReview(item)), ...(next ? { nextCursor: next } : {}) };
  }

  async getReview(ref: ProviderRepositoryRef, number: number): Promise<ReviewDetails> {
    const { data } = await this.client.get<any>(path`/repos/${ref.owner}/${ref.name}/pulls/${number}`);
    return { ...this.mapReview(data), body: data.body ?? undefined, mergeable: data.mergeable ?? undefined, createdAt: data.created_at, updatedAt: data.updated_at };
  }

  async createReview(ref: ProviderRepositoryRef, input: CreateReviewInput): Promise<Review> {
    const { data } = await this.client.post<any>(path`/repos/${ref.owner}/${ref.name}/pulls`, { title: input.title, body: input.body, head: input.sourceBranch, base: input.targetBranch, draft: input.draft });
    return this.mapReview(data);
  }

  async compare(ref: ProviderRepositoryRef, base: string, head: string): Promise<Comparison> {
    const { data } = await this.client.get<any>(`${path`/repos/${ref.owner}/${ref.name}/compare/${base}`}...${encodeURIComponent(head)}`);
    return {
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      commits: data.commits.map((commit: any) => ({
        id: commit.sha,
        shortId: commit.sha.slice(0, 7),
        parents: commit.parents.map((parent: any) => parent.sha),
        authorName: commit.commit.author?.name ?? commit.author?.login ?? "unknown",
        authorEmail: commit.commit.author?.email ?? "",
        authoredAt: commit.commit.author?.date ?? "",
        subject: commit.commit.message.split("\n", 1)[0]!,
      })),
      patchUrl: `${data.html_url}.diff`,
    };
  }

  async checks(ref: ProviderRepositoryRef, revision: string): Promise<CheckSummary[]> {
    const [{ data: runs }, { data: statuses }] = await Promise.all([
      this.client.get<any>(path`/repos/${ref.owner}/${ref.name}/commits/${revision}/check-runs`),
      this.client.get<any>(path`/repos/${ref.owner}/${ref.name}/commits/${revision}/status`),
    ]);
    return [
      ...runs.check_runs.map((run: any) => ({ id: String(run.id), name: run.name, state: checkState(run.status, run.conclusion), webUrl: run.html_url ?? undefined, startedAt: run.started_at ?? undefined, completedAt: run.completed_at ?? undefined })),
      ...statuses.statuses.map((status: any) => ({ id: String(status.id), name: status.context, state: checkState(status.state, status.state), webUrl: status.target_url ?? undefined })),
    ];
  }

  /**
   * List issues.
   *
   * GitHub's issues endpoint returns PULL REQUESTS TOO — a pull request is an
   * issue in its data model, and every one of them arrives with a
   * `pull_request` key. Left unfiltered, "list the open issues" answers with
   * the open PRs mixed in, which is wrong in a way that reads as right until
   * somebody counts.
   */
  async listIssues(ref: ProviderRepositoryRef, query: IssueQuery = {}): Promise<Page<Issue>> {
    const page = Number(query.cursor ?? "1");
    const perPage = query.limit ?? 30;

    const response = await this.client.get<any[]>(path`/repos/${ref.owner}/${ref.name}/issues`, {
      state: query.state ?? "open",
      page,
      per_page: perPage,
      ...(query.labels?.length ? { labels: query.labels.join(",") } : {}),
      ...(query.assignee ? { assignee: query.assignee } : {}),
    });

    const items = response.data.filter((item: any) => !item.pull_request).map((item: any) => this.mapIssue(item));
    // Paginate on what GitHub returned, not on what survived the filter: a
    // page that was all pull requests still has a next page behind it.
    const next = nextCursor(response, page, perPage);

    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async getIssue(ref: ProviderRepositoryRef, number: number): Promise<IssueDetails> {
    const { data } = await this.client.get<any>(path`/repos/${ref.owner}/${ref.name}/issues/${number}`);

    if ((data as any).pull_request) {
      throw new Error(
        `#${number} in ${ref.owner}/${ref.name} is a pull request, not an issue. Use getReview for pull requests.`,
      );
    }

    return {
      ...this.mapIssue(data),
      body: data.body ?? undefined,
      closedAt: data.closed_at ?? undefined,
      commentCount: data.comments,
    };
  }

  async createIssue(ref: ProviderRepositoryRef, input: CreateIssueInput): Promise<Issue> {
    const { data } = await this.client.post<any>(path`/repos/${ref.owner}/${ref.name}/issues`, {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      ...(input.assignees?.length ? { assignees: input.assignees } : {}),
    });

    return this.mapIssue(data);
  }

  /**
   * Update an issue.
   *
   * Only the fields present are sent. Echoing the whole issue back would
   * clobber whatever someone else changed between the read and the write, and
   * on an issue tracker that someone is usually a person mid-conversation.
   */
  async updateIssue(
    ref: ProviderRepositoryRef,
    number: number,
    input: UpdateIssueInput,
  ): Promise<Issue> {
    const { data } = await this.client.patch<any>(path`/repos/${ref.owner}/${ref.name}/issues/${number}`, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.assignees !== undefined ? { assignees: input.assignees } : {}),
    });

    return this.mapIssue(data);
  }

  async commentOnIssue(
    ref: ProviderRepositoryRef,
    number: number,
    body: string,
  ): Promise<{ id: string; webUrl: string }> {
    const { data } = await this.client.post<any>(path`/repos/${ref.owner}/${ref.name}/issues/${number}/comments`, { body });

    return { id: String(data.id), webUrl: data.html_url };
  }

  private mapIssue(item: any): Issue {
    return {
      id: String(item.id),
      number: item.number,
      title: item.title,
      state: (item.state === "closed" ? "closed" : "open") as IssueState,
      webUrl: item.html_url,
      author: item.user?.login ?? "unknown",
      labels: (item.labels ?? []).map((label: any) =>
        typeof label === "string" ? label : (label?.name ?? ""),
      ),
      assignees: (item.assignees ?? []).map((user: any) => user?.login ?? ""),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  }

  private mapReview(item: any): Review {
    return {
      id: String(item.id),
      number: item.number,
      title: item.title,
      state: reviewState(item.state, item.draft, item.merged),
      webUrl: item.html_url,
      sourceBranch: item.head.ref,
      targetBranch: item.base.ref,
      author: item.user?.login ?? "unknown",
    };
  }
}
