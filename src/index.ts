import { Octokit } from "octokit";
import type {
  CheckState,
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

export interface GitHubProviderOptions {
  token?: string;
  baseUrl?: string;
  client?: Octokit;
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

export class GitHubProvider implements GitProvider {
  readonly kind = "github" as const;
  private readonly baseUrl: string;
  private readonly client: Octokit;

  constructor(options: GitHubProviderOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "https://api.github.com";
    this.client = options.client ?? new Octokit({ auth: options.token, baseUrl: this.baseUrl });
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
    const { data } = await this.client.rest.repos.get({ owner: ref.owner, repo: ref.name });
    return { provider: this.kind, owner: ref.owner, name: ref.name, id: String(data.id), webUrl: data.html_url, defaultBranch: data.default_branch, private: data.private, description: data.description ?? undefined, ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}) };
  }

  async listReviews(ref: ProviderRepositoryRef, query: ReviewQuery = {}): Promise<Page<Review>> {
    const state = query.state === "merged" || query.state === "closed" ? "closed" : query.state === "open" || query.state === "draft" ? "open" : "all";
    const page = Number(query.cursor ?? "1");
    const { data } = await this.client.rest.pulls.list({ owner: ref.owner, repo: ref.name, state, page, per_page: query.limit ?? 30 });
    return { items: data.map((item) => this.mapReview(item)), ...(data.length === (query.limit ?? 30) ? { nextCursor: String(page + 1) } : {}) };
  }

  async getReview(ref: ProviderRepositoryRef, number: number): Promise<ReviewDetails> {
    const { data } = await this.client.rest.pulls.get({ owner: ref.owner, repo: ref.name, pull_number: number });
    return { ...this.mapReview(data), body: data.body ?? undefined, mergeable: data.mergeable ?? undefined, createdAt: data.created_at, updatedAt: data.updated_at };
  }

  async createReview(ref: ProviderRepositoryRef, input: CreateReviewInput): Promise<Review> {
    const { data } = await this.client.rest.pulls.create({ owner: ref.owner, repo: ref.name, title: input.title, body: input.body, head: input.sourceBranch, base: input.targetBranch, draft: input.draft });
    return this.mapReview(data);
  }

  async compare(ref: ProviderRepositoryRef, base: string, head: string): Promise<Comparison> {
    const { data } = await this.client.rest.repos.compareCommits({ owner: ref.owner, repo: ref.name, base, head });
    return {
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      commits: data.commits.map((commit) => ({
        id: commit.sha,
        shortId: commit.sha.slice(0, 7),
        parents: commit.parents.map((parent) => parent.sha),
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
      this.client.rest.checks.listForRef({ owner: ref.owner, repo: ref.name, ref: revision }),
      this.client.rest.repos.getCombinedStatusForRef({ owner: ref.owner, repo: ref.name, ref: revision }),
    ]);
    return [
      ...runs.check_runs.map((run) => ({ id: String(run.id), name: run.name, state: checkState(run.status, run.conclusion), webUrl: run.html_url ?? undefined, startedAt: run.started_at ?? undefined, completedAt: run.completed_at ?? undefined })),
      ...statuses.statuses.map((status) => ({ id: String(status.id), name: status.context, state: checkState(status.state, status.state), webUrl: status.target_url ?? undefined })),
    ];
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
