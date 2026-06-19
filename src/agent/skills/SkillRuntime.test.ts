import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

test("SkillRuntime loads a workspace skill and lists support files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "my-agent-skill-runtime-"));
  try {
    await mkdir(join(cwd, "skills", "demo-skill", "references"), { recursive: true });
    await writeFile(
      join(cwd, "skills", "demo-skill", "SKILL.md"),
      [
        "---",
        "name: demo-skill",
        "description: Format answers using a demo skill.",
        "when_to_use: Use when the user asks for demo formatting.",
        "---",
        "",
        "Always answer with DEMO-SKILL-APPLIED.",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "skills", "demo-skill", "references", "style.md"),
      "Support file",
    );

    const { SkillRuntime } = await import("@/agent/skills/SkillRuntime");
    const runtime = new SkillRuntime();
    const loaded = await runtime.load({
      cwd,
      skillName: "demo-skill",
      userId: "usr_runtime_test",
    });

    assert.equal(loaded.name, "demo-skill");
    assert.equal(loaded.source, "workspace");
    assert.match(loaded.content, /DEMO-SKILL-APPLIED/);
    assert.deepEqual(loaded.linkedFiles, ["references/style.md"]);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});
