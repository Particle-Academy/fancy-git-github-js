import { describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "../src/index.js";
import { supportsIssues } from "@particle-academy/fancy-git";

/** A stand-in Octokit exposing only the endpoints these methods touch. */
function fakeClient(overrides: Record<string, any> = {}) {
  const calls: { endpoint: string; args: any }[] = [];
  const record = (endpoint: string, result: any) => (args: any) => {
    calls.push({ endpoint, args });
    return Promise.resolve({ data: typeof result === "function" ? result(args) : result });
  };

  const client = {
    calls,
    rest: {
      issues: {
        listForRepo: record("listForRepo", overrides.listForRepo ?? []),
        get: record("get", overrides.get ?? {}),
        create: record("create", overrides.create ?? {}),
        update: record("update", overrides.update ?? {}),
        createComment: record("createComment", overrides.createComment ?? { id: 1, html_url: "u" }),
      },
    },
  };

  return client as any;
}

const REF = { provider: "github" as const, owner: "acme", name: "app" };

const issue = (over: Record<string, any> = {}) => ({
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

describe("the issue capability is optional and declared", () => {
  it("reports that the GitHub provider tracks issues", () => {
    // Callers ask before reaching for issue methods, because a provider without
    // a tracker is a perfectly good GitProvider. This is that check.
    expect(supportsIssues(new GitHubProvider({ client: fakeClient() }))).toBe(true);
  });

  it("reports that a provider without the methods does not", () => {
    const bare = { kind: "github", identify: () => null } as any;
    expect(supportsIssues(bare)).toBe(false);
  });
});

describe("listIssues", () => {
  it("excludes pull requests, which GitHub returns from the issues endpoint", () => {
    // A pull request IS an issue in GitHub's data model and arrives with a
    // `pull_request` key. Unfiltered, "list the open issues" answers with the
    // open PRs mixed in — wrong in a way that reads as right until you count.
    const client = fakeClient({
      listForRepo: [issue({ number: 7 }), issue({ number: 8, pull_request: { url: "…" } }), issue({ number: 9 })],
    });

    return new GitHubProvider({ client }).listIssues(REF).then((page) => {
      expect(page.items.map((i) => i.number)).toEqual([7, 9]);
    });
  });

  it("pages on what GitHub returned, not on what survived the filter", async () => {
    // A full page that happened to be all pull requests still has a next page
    // behind it. Paginating on the filtered count would stop early and silently
    // hide every issue after it.
    const client = fakeClient({
      listForRepo: Array.from({ length: 2 }, (_, i) => issue({ number: i, pull_request: { url: "…" } })),
    });

    const page = await new GitHubProvider({ client }).listIssues(REF, { limit: 2 });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe("2");
  });

  it("passes labels and assignee through in GitHub's own shape", async () => {
    const client = fakeClient({ listForRepo: [] });
    await new GitHubProvider({ client }).listIssues(REF, { labels: ["bug", "p1"], assignee: "ada" });

    expect(client.calls[0].args.labels).toBe("bug,p1");
    expect(client.calls[0].args.assignee).toBe("ada");
  });

  it("normalizes the issue shape", async () => {
    const client = fakeClient({ listForRepo: [issue()] });
    const page = await new GitHubProvider({ client }).listIssues(REF);

    expect(page.items[0]).toEqual({
      id: "100",
      number: 7,
      title: "Broken",
      state: "open",
      webUrl: "https://github.com/acme/app/issues/7",
      author: "ada",
      labels: ["bug"],
      assignees: ["grace"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });
});

describe("getIssue", () => {
  it("refuses a number that is actually a pull request", async () => {
    // Same numbering space, different thing. Returning the PR as though it were
    // an issue is how a workflow closes the wrong item.
    const client = fakeClient({ get: issue({ pull_request: { url: "…" } }) });

    await expect(new GitHubProvider({ client }).getIssue(REF, 7)).rejects.toThrow(
      /is a pull request, not an issue/,
    );
  });

  it("carries the detail fields", async () => {
    const client = fakeClient({ get: issue({ body: "steps", closed_at: null, comments: 3 }) });
    const details = await new GitHubProvider({ client }).getIssue(REF, 7);

    expect(details.body).toBe("steps");
    expect(details.commentCount).toBe(3);
    expect(details.closedAt).toBeUndefined();
  });
});

describe("updateIssue", () => {
  it("sends ONLY the fields given", async () => {
    // A partial update. Echoing the whole issue back would clobber whatever
    // someone else changed between the read and the write — and on a tracker
    // that someone is usually a person mid-conversation.
    const client = fakeClient({ update: issue({ state: "closed" }) });
    await new GitHubProvider({ client }).updateIssue(REF, 7, { state: "closed" });

    const args = client.calls[0].args;
    expect(args.state).toBe("closed");
    expect(args).not.toHaveProperty("title");
    expect(args).not.toHaveProperty("body");
    expect(args).not.toHaveProperty("labels");
  });

  it("can clear labels, which is different from not mentioning them", async () => {
    // `labels: []` means "remove them all" and must survive; only an ABSENT key
    // means "leave alone".
    const client = fakeClient({ update: issue({ labels: [] }) });
    await new GitHubProvider({ client }).updateIssue(REF, 7, { labels: [] });

    expect(client.calls[0].args.labels).toEqual([]);
  });
});

describe("createIssue", () => {
  it("omits empty optionals rather than sending nulls", async () => {
    const client = fakeClient({ create: issue() });
    await new GitHubProvider({ client }).createIssue(REF, { title: "Broken" });

    const args = client.calls[0].args;
    expect(args.title).toBe("Broken");
    expect(args).not.toHaveProperty("body");
    expect(args).not.toHaveProperty("labels");
  });
});
