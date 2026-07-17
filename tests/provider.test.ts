import { describe, expect, it } from "vitest";
import { GitHubProvider } from "../src/index.js";

describe("GitHubProvider", () => {
  it("identifies HTTPS and SSH GitHub remotes", () => {
    const provider = new GitHubProvider();
    expect(provider.identify({ name: "origin", fetchUrl: "git@github.com:Particle-Academy/fancy-git-js.git" })).toEqual({
      provider: "github",
      owner: "Particle-Academy",
      name: "fancy-git-js",
    });
  });

  it("does not claim unrelated remotes", () => {
    expect(new GitHubProvider().identify({ name: "origin", fetchUrl: "https://gitlab.com/acme/app.git" })).toBeNull();
  });
});
