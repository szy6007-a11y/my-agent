import { NextRequest, NextResponse } from "next/server";

import { getArtifactForDownload } from "@/agent/tools/FileWorkspace";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ artifactId: string }>;
};

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "artifact";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

  const { artifactId } = await context.params;
  const artifact = await getArtifactForDownload({
    artifactId,
    userId: auth.user.id,
  });

  if (!artifact) {
    return NextResponse.json(
      {
        error: "文件不存在或无权访问",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  return new NextResponse(new Uint8Array(artifact.content), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": contentDisposition(artifact.metadata.filename),
      "Content-Length": String(artifact.content.length),
      "Content-Type": artifact.metadata.contentType,
    },
  });
}
