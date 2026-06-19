import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

test("selectBackgroundReviewTargets triggers memory on user-turn interval", async () => {
  const { selectBackgroundReviewTargets } = await import("@/agent/review/BackgroundReviewAgent");

  assert.deepEqual(
    selectBackgroundReviewTargets({
      memoryInterval: 10,
      skillInterval: 10,
      toolIterationsThisRun: 0,
      totalToolIterations: 0,
      userTurns: 10,
    }),
    { memory: true, skills: false },
  );

  assert.deepEqual(
    selectBackgroundReviewTargets({
      memoryInterval: 10,
      skillInterval: 10,
      toolIterationsThisRun: 0,
      totalToolIterations: 0,
      userTurns: 11,
    }),
    { memory: false, skills: false },
  );
});
test("selectBackgroundReviewTargets triggers skills only when this run crosses threshold", async () => {
  const { selectBackgroundReviewTargets } = await import("@/agent/review/BackgroundReviewAgent");

  assert.deepEqual(
    selectBackgroundReviewTargets({
      memoryInterval: 0,
      skillInterval: 10,
      toolIterationsThisRun: 3,
      totalToolIterations: 12,
      userTurns: 3,
    }),
    { memory: false, skills: true },
  );

  assert.deepEqual(
    selectBackgroundReviewTargets({
      memoryInterval: 0,
      skillInterval: 10,
      toolIterationsThisRun: 0,
      totalToolIterations: 10,
      userTurns: 3,
    }),
    { memory: false, skills: false },
  );

  assert.deepEqual(
    selectBackgroundReviewTargets({
      memoryInterval: 0,
      skillInterval: 10,
      toolIterationsThisRun: 2,
      totalToolIterations: 12,
      userTurns: 3,
    }),
    { memory: false, skills: false },
  );
});
