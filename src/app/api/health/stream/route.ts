import { NextRequest } from "next/server";

import {
  HEALTH_HEARTBEAT_INTERVAL_MS,
  HEALTH_MONITOR_INTERVAL_MS,
  describeServiceHealth,
  getServiceHealthSnapshot,
  serviceHealthFingerprint,
} from "@/lib/service-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ServiceLogLevel = "info" | "warn" | "error";

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let sequence = 0;
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let lastFingerprint = "";
      let monitorTimer: ReturnType<typeof setInterval> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(encodeSse(event, data)));
      };

      const sendLog = (
        level: ServiceLogLevel,
        source: string,
        message: string,
      ) => {
        send("status.log", {
          type: "status.log",
          sequence: ++sequence,
          at: new Date().toISOString(),
          level,
          source,
          message,
        });
      };

      const emitSnapshot = (reason: "initial" | "tick") => {
        const snapshot = getServiceHealthSnapshot();
        const fingerprint = serviceHealthFingerprint(snapshot);

        send("status.snapshot", {
          type: "status.snapshot",
          sequence: ++sequence,
          snapshot,
        });

        if (reason === "initial") {
          lastFingerprint = fingerprint;
          sendLog("info", "monitor", `监听已连接：${describeServiceHealth(snapshot)}`);
          return;
        }

        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          sendLog(
            snapshot.status === "ok" ? "info" : "warn",
            "monitor",
            `服务状态变化：${describeServiceHealth(snapshot)}`,
          );
        }
      };

      cleanup = () => {
        if (closed) {
          return;
        }

        closed = true;

        if (monitorTimer) {
          clearInterval(monitorTimer);
        }

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }

        request.signal.removeEventListener("abort", cleanup!);

        try {
          controller.close();
        } catch {
          // The stream may already be closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
      emitSnapshot("initial");

      monitorTimer = setInterval(() => {
        emitSnapshot("tick");
      }, HEALTH_MONITOR_INTERVAL_MS);

      heartbeatTimer = setInterval(() => {
        send("status.heartbeat", {
          type: "status.heartbeat",
          sequence: ++sequence,
          at: new Date().toISOString(),
        });
      }, HEALTH_HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
