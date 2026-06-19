import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

function skillBundle(files: Array<{ content: Buffer; path: string }>) {
  return {
    files,
    identifier: "owner/repo/skill@abc123",
    metadata: {},
    source: "github" as const,
    trustLevel: "community" as const,
  };
}

test("validateSkillBundle accepts a valid skill bundle and parses manifest fields", async () => {
  const { validateSkillBundle } = await import("@/agent/skills/SkillBundleValidator");
  const result = validateSkillBundle(
    skillBundle([
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
    ]),
  );

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
  const result = validateSkillBundle(
    skillBundle([
      {
        content: Buffer.from("---\nname: bad\n---\n"),
        path: "SKILL.md",
      },
      {
        content: Buffer.from("nope"),
        path: "../outside.txt",
      },
    ]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Unsafe skill file path/);
});

test("validateSkillBundle requires SKILL.md at selected root", async () => {
  const { validateSkillBundle } = await import("@/agent/skills/SkillBundleValidator");
  const result = validateSkillBundle(
    skillBundle([
      {
        content: Buffer.from("nested"),
        path: "nested/SKILL.md",
      },
    ]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /must contain SKILL\.md/);
});

test("validateSkillBundle accepts asset-heavy skills below the production total limit", async () => {
  const { validateSkillBundle } = await import("@/agent/skills/SkillBundleValidator");
  const result = validateSkillBundle(
    skillBundle([
      {
        content: Buffer.from("---\nname: ppt-skill\n---\nUse local image assets.\n"),
        path: "SKILL.md",
      },
      {
        content: Buffer.alloc(900 * 1024, "a"),
        path: "assets/background-a.webp",
      },
      {
        content: Buffer.alloc(900 * 1024, "b"),
        path: "assets/background-b.webp",
      },
      {
        content: Buffer.alloc(400 * 1024, "c"),
        path: "assets/background-c.webp",
      },
    ]),
  );

  assert.equal(result.ok, true);
});

test("validateSkillBundle rejects bundles above the production total limit", async () => {
  const { MAX_SKILL_TOTAL_BYTES, validateSkillBundle } = await import(
    "@/agent/skills/SkillBundleValidator"
  );
  const result = validateSkillBundle(
    skillBundle([
      {
        content: Buffer.from("---\nname: too-large\n---\n"),
        path: "SKILL.md",
      },
      ...Array.from({ length: Math.ceil(MAX_SKILL_TOTAL_BYTES / (900 * 1024)) + 1 }, (_, index) => ({
        content: Buffer.alloc(900 * 1024, "a"),
        path: `assets/large-${index}.webp`,
      })),
    ]),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Skill bundle is .* limit is/);
});
