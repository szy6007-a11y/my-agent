import type { AgentEvent } from "@/agent/runtime/types";
import {
  type StoredToolApproval,
  type ToolApprovalDecision,
} from "@/agent/sessions/SessionRepository";

export type ApprovalRepository = {
  appendRunEvent(runId: string, event: AgentEvent): Promise<number | null>;
  getToolApprovalForUser(input: {
    approvalId: string;
    userId: string;
  }): Promise<StoredToolApproval | null>;
  resolveToolApproval(input: {
    approvalId: string;
    decision: ToolApprovalDecision;
    decisionReason?: string;
    userId: string;
  }): Promise<StoredToolApproval | null>;
};

export type ResolveToolApprovalResult =
  | {
      approval: StoredToolApproval;
      status: 200;
    }
  | {
      error: string;
      status: 404;
    }
  | {
      approval: StoredToolApproval;
      error: string;
      status: 409;
    };

export class ApprovalController {
  constructor(private readonly sessions: ApprovalRepository) {}

  async resolve(input: {
    approvalId: string;
    decision: ToolApprovalDecision;
    reason?: string;
    userId: string;
  }): Promise<ResolveToolApprovalResult> {
    const approval = await this.sessions.resolveToolApproval({
      approvalId: input.approvalId,
      decision: input.decision,
      decisionReason: input.reason,
      userId: input.userId,
    });

    if (approval) {
      await this.sessions.appendRunEvent(approval.runId, {
        type: "tool.approval.resolved",
        approvalId: approval.id,
        approved: approval.status === "approved",
        runId: approval.runId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
      });
      return { approval, status: 200 };
    }

    const existing = await this.sessions.getToolApprovalForUser({
      approvalId: input.approvalId,
      userId: input.userId,
    });

    if (!existing) {
      return { error: "审批不存在", status: 404 };
    }

    return {
      approval: existing,
      error: `审批已经是 ${existing.status} 状态`,
      status: 409,
    };
  }
}
