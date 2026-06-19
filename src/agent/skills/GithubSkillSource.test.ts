import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

const SKILL_BODY = [
  "---",
  "name: demo-skill",
  "description: Demo skill from repo root discovery.",
  "---",
  "",
  "Use DEMO-SKILL.",
].join("\n");

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    status: 200,
  });
}

function installMockFetch(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    if (!(key in routes)) {
      return new Response(`missing route ${key}`, { status: 404 });
    }
    return jsonResponse(routes[key]);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("GithubSkillSource installs the only nested skill when given a repo root", async () => {
  const restore = installMockFetch({
    "/repos/o/r": { default_branch: "main" },
    "/repos/o/r/commits/main": { sha: "abc123" },
    "/repos/o/r/git/trees/abc123?recursive=1": {
      tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
      truncated: false,
    },
    "/repos/o/r/contents/skills/demo?ref=abc123": [
      { path: "skills/demo/SKILL.md", type: "file" },
    ],
    "/repos/o/r/contents/skills/demo/SKILL.md?ref=abc123": {
      content: Buffer.from(SKILL_BODY).toString("base64"),
      encoding: "base64",
      path: "skills/demo/SKILL.md",
      type: "file",
    },
  });

  try {
    const { GithubSkillSource } = await import("@/agent/skills/GithubSkillSource");
    const source = new GithubSkillSource();
    const location = await source.resolve("https://github.com/o/r");
    const bundle = await source.fetchBundle(location);

    assert.equal(bundle.metadata.path, "skills/demo");
    assert.equal(bundle.files.length, 1);
    assert.equal(bundle.files[0]?.path, "SKILL.md");
    assert.match(bundle.files[0]?.content.toString("utf8") ?? "", /DEMO-SKILL/);
  } finally {
    restore();
  }
});

test("GithubSkillSource returns candidates when a repo root contains multiple skills", async () => {
  const restore = installMockFetch({
    "/repos/o/r": { default_branch: "main" },
    "/repos/o/r/commits/main": { sha: "abc123" },
    "/repos/o/r/git/trees/abc123?recursive=1": {
      tree: [
        { path: "skills/a/SKILL.md", type: "blob" },
        { path: "skills/b/SKILL.md", type: "blob" },
      ],
      truncated: false,
    },
  });

  try {
    const { GithubSkillSelectionRequiredError, GithubSkillSource } = await import(
      "@/agent/skills/GithubSkillSource"
    );
    const source = new GithubSkillSource();
    const location = await source.resolve("https://github.com/o/r");

    await assert.rejects(
      () => source.fetchBundle(location),
      (error) => {
        assert.ok(error instanceof GithubSkillSelectionRequiredError);
        assert.deepEqual(error.candidates.map((candidate) => candidate.path), [
          "skills/a",
          "skills/b",
        ]);
        return true;
      },
    );
  } finally {
    restore();
  }
});
