import { GitHubProvider } from "../../src/index.js";
import type { FakeFetch } from "./fake-fetch.js";

/**
 * The ONE place the transport tests know how the provider reaches HTTP. Every
 * assertion is made against the recorded fetch calls, so swapping the client
 * underneath changes this function and nothing else.
 *
 * Until 2026-11-19 this built an Octokit with `request.fetch`; the same
 * assertions passed against it before the first-party client replaced it.
 */
export function makeProvider(fetch: FakeFetch, options: { token?: string; baseUrl?: string } = {}): GitHubProvider {
  return new GitHubProvider({ ...options, fetch });
}
