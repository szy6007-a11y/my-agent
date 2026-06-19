import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalController } from "@/agent/runtime/ApprovalController";
import type { AgentEvent } from "@/agent/runtime/types";
import type {
  StoredToolApproval,
  ToolApprovalDecision,
} from "@/agent/sessions/SessionRepository";

function approval(overrides: Partial<StoredToolApproval> = {}): StoredToolApproval {
  return {
    id: "approval_1",
    createdAt: new Date(0).toISOString(),
    decision: null,
    reason: "需要确认",
    request: { toolArguments: { value: "ok" } },
    resolvedAt: null,
    risk: "write",
    runId: "run_1",
    sessionId: "sess_1",
    status: "pending",
    toolCallId: "call_1",
    toolName: "fake_write",
    userId: "usr_1",
    ...overrides,
  };
}

class FakeApprovalRepository {
  existing: StoredToolApproval | null;
  resolved: StoredToolApproval | null;
  resolveCalls: Array<{
    approvalId: string;
    decision: ToolApprovalDecision;
    decisionReason?: string;
    userId: string;
  }> = [];
  runEvents: Array<{ event: AgentEvent; runId: string }> = [];

  constructor(input: {
    existing?: StoredToolApproval | null;
    resolved?: StoredToolApproval | null;
  }) {
    this.existing = input.existing ?? null;
    this.resolved = input.resolved ?? null;
  }

  async resolveToolApproval(input: {
    approvalId: string;
    decision: ToolApprovalDecision;
    decisionReason?: string;
    userId: string;
  }) {
    this.resolveCalls.push(input);
    return this.resolved;
  }

  async getToolApprovalForUser() {
    return this.existing;
  }

  async appendRunEvent(runId: string, event: AgentEvent) {
    this.runEvents.push({ event, runId });
  }
}

test("ApprovalController resolves a pending approval", async () => {
  const resolved = approval({ status: "approved" });
  const repository = new FakeApprovalRepository({ resolved });
  const controller = new ApprovalController(repository as never);

  const result = await controller.resolve({
    approvalId: "approval_1",
    decision: "approved",
    reason: "用户确认",
    userId: "usr_1",
  });

  assert.deepEqual(result, { approval: resolved, status: 200 });
  assert.deepEqual(repository.resolveCalls, [
    {
      approvalId: "approval_1",
      decision: "approved",
      decisionReason: "用户确认",
      userId: "usr_1",
    },
  ]);
  assert.deepEqual(repository.runEvents, [
    {
      runId: "run_1",
      event: {
        type: "tool.approval.resolved",
        approvalId: "approval_1",
        approved: true,
        runId: "run_1",
        status: "approved",
        toolCallId: "call_1",
        toolName: "fake_write",
      },
    },
  ]);
});

test("ApprovalController reports conflict for already resolved approvals", async () => {
  const existing = approval({ status: "approved" });
  const repository = new FakeApprovalRepository({ existing, resolved: null });
  const controller = new ApprovalController(repository as never);

  const result = await controller.resolve({
    approvalId: "approval_1",
    decision: "rejected",
    userId: "usr_1",
  });

  assert.deepEqual(result, {
    approval: existing,
    error: "审批已经是 approved 状态",
    status: 409,
  });
  assert.deepEqual(repository.runEvents, []);
});

test("ApprovalController reports missing approvals", async () => {
  const repository = new FakeApprovalRepository({ existing: null, resolved: null });
  const controller = new ApprovalController(repository as never);

  const result = await controller.resolve({
    approvalId: "approval_missing",
    decision: "approved",
    userId: "usr_1",
  });

  assert.deepEqual(result, {
    error: "审批不存在",
    status: 404,
  });
});
