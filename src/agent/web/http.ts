import { TextDecoder } from "util";

export type FetchJsonOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  maxErrorBytes?: number;
  method?: "GET" | "POST";
  signal?: AbortSignal;
  timeoutMs: number;
};

export type ReadTextOptions = {
  maxBytes?: number;
};

function resolveTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return 30_000;
  }
  return Math.max(1, Math.min(180_000, Math.trunc(timeoutMs)));
}

export function combineSignalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Request timed out"));
  }, resolveTimeoutMs(timeoutMs));

  const abortFromParent = () => {
    controller.abort(signal?.reason ?? new Error("Request aborted"));
  };

  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}

async function readStreamBytes(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }

      if (bytesRead + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - bytesRead);
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          bytesRead += remaining;
        }
        truncated = true;
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, bytesRead, truncated };
}

export async function readResponseText(
  response: Response,
  options: ReadTextOptions = {},
): Promise<{ bytesRead: number; text: string; truncated: boolean }> {
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? Math.trunc(options.maxBytes) : 0;
  if (maxBytes > 0 && response.body) {
    const { bytes, bytesRead, truncated } = await readStreamBytes(response.body, maxBytes);
    return {
      bytesRead,
      text: new TextDecoder("utf-8").decode(bytes),
      truncated,
    };
  }

  const text = await response.text();
  return {
    bytesRead: text.length,
    text,
    truncated: false,
  };
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
  const timeout = combineSignalWithTimeout(options.signal, options.timeoutMs);
  try {
    const response = await fetch(url, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      signal: timeout.signal,
    });
    const text = await readResponseText(response, {
      maxBytes: options.maxErrorBytes ?? 256_000,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.text || response.statusText}`);
    }
    if (!text.text.trim()) {
      return {};
    }
    return JSON.parse(text.text) as unknown;
  } finally {
    timeout.cleanup();
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, Math.max(0, maxChars - 29))}\n\n[... truncated ...]`,
    truncated: true,
  };
}
