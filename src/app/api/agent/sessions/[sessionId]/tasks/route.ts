import { NextRequest, NextResponse } from "next/server";

import { sessionRepository, type StoredAgentTask } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";
import type { AgentTaskSummary } from "@/shared/agent-protocol";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function toTaskSummary(task: StoredAgentTask): AgentTaskSummary {
  return {
    activeForm: task.activeForm,
    background: task.background,
    childRunId: task.childRunId,
    childSessionId: task.childSessionId,
    completedAt: task.completedAt,
    context: task.context,
    createdAt: task.createdAt,
    description: task.description,
    error: task.error,
    goal: task.goal,
    id: task.id,
    kind: task.kind,
    model: task.model,
    parentRunId: task.parentRunId,
    parentSessionId: task.parentSessionId,
    resultPreview: task.resultPreview,
    role: task.role,
    startedAt: task.startedAt,
    status: task.status,
    subject: task.subject,
    toolsets: task.toolsets,
    updatedAt: task.updatedAt,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getAuthenticatedUser(request);

  if (!auth) {
    return NextResponse.json(
      {
        error: "未登录",
        environment: getAuthEnvironment(),
      },
      { status: 401 },
    );
  }

  const { sessionId } = await context.params;
  const requestedSession = await sessionRepository.getSessionForUser(
    sessionId,
    auth.user.id,
  );
  const session =
    requestedSession ?
      (await sessionRepository.resolveCompressionHead({
        sessionId: requestedSession.id,
        userId: auth.user.id,
      })) ?? requestedSession
    : null;

  if (!session) {
    return NextResponse.json(
      {
        error: "会话不存在",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  const tasks = await sessionRepository.listAgentTasks({
    includeAncestors: true,
    limit: 100,
    sessionId: session.id,
    userId: auth.user.id,
  });

  return NextResponse.json({
    environment: getAuthEnvironment(),
    session,
    tasks: tasks.map(toTaskSummary),
  });
}
