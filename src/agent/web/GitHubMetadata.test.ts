import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichGitHubSearchResults,
  parseGitHubRepoUrl,
} from "@/agent/web/GitHubMetadata";

function withEnv(name: string, value: string | undefined, run: () => Promise<void> | void) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("parseGitHubRepoUrl extracts repository names from GitHub result URLs", () => {
  assert.deepEqual(parseGitHubRepoUrl("https://github.com/anthropics/financial-services"), {
    fullName: "anthropics/financial-services",
    owner: "anthropics",
    repo: "financial-services",
  });
  assert.deepEqual(parseGitHubRepoUrl("https://github.com/tradermonty/claude-trading-skills/tree/main/skills"), {
    fullName: "tradermonty/claude-trading-skills",
    owner: "tradermonty",
    repo: "claude-trading-skills",
  });
  assert.equal(parseGitHubRepoUrl("https://github.com/topics/agent-skills"), null);
});

test("enrichGitHubSearchResults adds live repository metadata from GitHub REST API", async () => {
  await withEnv("WEB_SEARCH_GITHUB_ENRICH_LIMIT", "2", async () => {
    const previousFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            default_branch: "main",
            description: "Reference agents for financial services.",
            forks_count: 4598,
            full_name: "anthropics/financial-services",
            html_url: "https://github.com/anthropics/financial-services",
            language: "Python",
            license: { spdx_id: "Apache-2.0" },
            open_issues_count: 166,
            pushed_at: "2026-06-05T20:53:09Z",
            stargazers_count: 31979,
            updated_at: "2026-06-20T10:48:09Z",
          }),
      } as Response;
    };

    try {
      const results = await enrichGitHubSearchResults(
        [
          {
            description: "GitHub result without stars in snippet",
            position: 1,
            title: "GitHub - anthropics/financial-services",
            url: "https://github.com/anthropics/financial-services",
          },
        ],
        { now: new Date("2026-06-20T10:51:06Z") },
      );

      assert.deepEqual(urls, ["https://api.github.com/repos/anthropics/financial-services"]);
      assert.equal(results[0]?.metadata?.github?.stars, 31979);
      assert.equal(results[0]?.metadata?.github?.retrieved_at, "2026-06-20T10:51:06.000Z");
      assert.equal(results[0]?.metadata?.github?.source, "github_rest_api");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
