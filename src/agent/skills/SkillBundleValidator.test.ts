import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

test("validateSkillBundle accepts a valid skill bundle and parses manifest fields", async () => {
  const { validateSkillBundle } = await import("@/agent/skills/SkillBundleValidator");
  const result = validateSkillBundle({
    files: [
      {
        content: Buffer.from(
          [
            "---",
            "name: one-three-one",
            "description: Produce a 1-3-1 structured answer.",
            "allowed-tools: [Skill, web_search]",
            "context: fork",
            "---",
            "",
            "Use one summary, three bullets, and one next step.",
          ].join("\n"),
        ),
        path: "SKILL.md",
      },
      {
        content: Buffer.from("Reference text"),
        path: "references/style.md",
      },
    ],
    identifier: "owner/repo/one-three-one@abc123",
    metadata: {},
    source: "github",
    trustLevel: "community",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.manifest.name, "one-three-one");
  assert.equal(result.bundle.manifest.context, "fork");
  assert.deepEqual(result.bundle.manifest.allowedTools, ["Skill", "web_search"]);
  assert.deepEqual(
    result.bundle.files.map((file) => file.path).sort(),
    ["SKILL.md", "references/style.md"],
  );
});

test("validateSkillBundle rejects traversal paths", async () => {
  const { validateSkillBundle } = await import("@/agent/skills/SkillBundleValidator");
  const result = validateSkillBundle({
    files: [
      {
        content: Buffer.from("---\nname: bad\n---\n"),
        path: "SKILL.md",
      },
      {
        content: Buffer.from("nope"),
        path: "../outside.txt",
      },
    ],
    identifier: "bad",
    metadata: {},
    source: "github",
    trustLevel: "community",
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Unsafe skill file path/);
});

test("validateSkillBundle requires SKILL.md at selected root", async () => {
  const { validateSkillBundle } = await import("@/agent/skills/SkillBundleValidator");
  const result = validateSkillBundle({
    files: [
      {
        content: Buffer.from("nested"),
        path: "nested/SKILL.md",
      },
    ],
    identifier: "missing-root",
    metadata: {},
    source: "github",
    trustLevel: "community",
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /must contain SKILL\.md/);
});
