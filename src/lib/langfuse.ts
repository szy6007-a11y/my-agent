import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { serverEnv } from "@/lib/env";

type LangfuseGlobals = typeof globalThis & {
  __myAgentLangfuse?: {
    processor: LangfuseSpanProcessor;
    sdk: NodeSDK;
  };
};

const SECRET_FIELD_PATTERN =
  /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:sk|sk-lf|pk-lf|Bearer)\b[-_A-Za-z0-9.]{8,}/g;

function maskLangfuseData(data: unknown): unknown {
  if (typeof data === "string") {
    return data.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
  }

  if (Array.isArray(data)) {
    return data.map(maskLangfuseData);
  }

  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        SECRET_FIELD_PATTERN.test(key) ? "[REDACTED]" : maskLangfuseData(value),
      ]),
    );
  }

  return data;
}

export function isLangfuseTracingEnabled() {
  return Boolean(serverEnv.LANGFUSE_PUBLIC_KEY && serverEnv.LANGFUSE_SECRET_KEY);
}

export function ensureLangfuseTracing() {
  if (!isLangfuseTracingEnabled()) {
    return;
  }

  const globals = globalThis as LangfuseGlobals;
  if (globals.__myAgentLangfuse) {
    return;
  }

  const processor = new LangfuseSpanProcessor({
    baseUrl: serverEnv.LANGFUSE_BASE_URL,
    environment:
      serverEnv.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    exportMode: process.env.NODE_ENV === "production" ? "batched" : "immediate",
    mask: ({ data }) => maskLangfuseData(data),
    publicKey: serverEnv.LANGFUSE_PUBLIC_KEY,
    secretKey: serverEnv.LANGFUSE_SECRET_KEY,
  });
  const sdk = new NodeSDK({
    serviceName: "my-agent",
    spanProcessors: [processor],
  });

  sdk.start();
  globals.__myAgentLangfuse = { processor, sdk };
}
