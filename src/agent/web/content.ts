import {
  DEFAULT_WEB_EXTRACT_MAX_CHARS,
  DEFAULT_WEB_EXTRACT_MIN_LENGTH,
} from "@/agent/web/env";
import { truncateText } from "@/agent/web/http";
import type { WebExtractDocument } from "@/agent/web/types";

const BASE64_IMAGE_PATTERN =
  /(?:\(|\b)data:image\/[^;()\s]+;base64,[A-Za-z0-9+/=]+(?:\)|\b)/g;
const MAX_LLM_INPUT_CHARS = 2_000_000;
const CHUNK_SIZE = 40_000;

export function cleanBase64Images(text: string): string {
  return text.replace(BASE64_IMAGE_PATTERN, "[BASE64_IMAGE_REMOVED]");
}

function extractAssistantText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

async function callSummarizer(input: {
  content: string;
  context: string;
  maxChars: number;
  signal?: AbortSignal;
}) {
  const [{ getDeepSeekClient, deepseekModels }, { serverEnv }] = await Promise.all([
    import("@/lib/ai/deepseek"),
    import("@/lib/env"),
  ]);
  const model = process.env.WEB_EXTRACT_SUMMARIZER_MODEL?.trim() || deepseekModels.default;
  const client = getDeepSeekClient({
    generationMetadata: {
      provider: "deepseek",
      task: "web_extract_summarization",
    },
    generationName: "web-extract-summarization",
    tags: ["agent", "web_extract", "summarization"],
    traceName: "web-extract-tool",
  });
  const response = await client.chat.completions.create(
    {
      max_tokens: Math.min(16_000, Math.max(1_000, Math.ceil(input.maxChars / 2))),
      messages: [
        {
          content:
            "You compress extracted web content for an AI agent. Preserve concrete facts, names, dates, figures, code/API details, citations, and caveats. Use concise markdown. Do not invent facts.",
          role: "system",
        },
        {
          content: `${input.context}\n\nReturn at most ${input.maxChars} characters.\n\nCONTENT:\n${input.content}`,
          role: "user",
        },
      ],
      model: model || serverEnv.DEEPSEEK_MODEL_DEFAULT,
      temperature: 0.1,
    },
    { signal: input.signal },
  );
  const text = extractAssistantText(response.choices[0]?.message.content).trim();
  return text ? truncateText(text, input.maxChars).text : "";
}

function chunkContent(content: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += CHUNK_SIZE) {
    chunks.push(content.slice(index, index + CHUNK_SIZE));
  }
  return chunks;
}

async function summarizeLargeContent(input: {
  content: string;
  maxChars: number;
  signal?: AbortSignal;
  title: string;
  url: string;
}) {
  if (input.content.length > MAX_LLM_INPUT_CHARS) {
    return `[Content refused: page content is ${input.content.length} characters, above the ${MAX_LLM_INPUT_CHARS} character processing limit.]`;
  }

  const context = `URL: ${input.url}\nTitle: ${input.title || "(untitled)"}`;
  const chunks = chunkContent(input.content);
  if (chunks.length === 1) {
    return await callSummarizer({
      content: input.content,
      context,
      maxChars: input.maxChars,
      signal: input.signal,
    });
  }

  const chunkSummaries = await Promise.all(
    chunks.map(async (chunk, index) => {
      try {
        return await callSummarizer({
          content: chunk,
          context: `${context}\nChunk: ${index + 1}/${chunks.length}`,
          maxChars: Math.min(input.maxChars, 8_000),
          signal: input.signal,
        });
      } catch {
        return "";
      }
    }),
  );
  const usable = chunkSummaries.filter(Boolean);
  if (usable.length === 0) {
    return truncateText(input.content, input.maxChars).text;
  }
  if (usable.length === 1) {
    return truncateText(usable[0], input.maxChars).text;
  }
  return await callSummarizer({
    content: usable.map((summary, index) => `## Section ${index + 1}\n${summary}`).join("\n\n---\n\n"),
    context: `${context}\nTask: synthesize chunk summaries into one cohesive summary.`,
    maxChars: input.maxChars,
    signal: input.signal,
  });
}

export async function processExtractDocuments(
  documents: WebExtractDocument[],
  options: {
    maxChars?: number;
    minLength?: number;
    signal?: AbortSignal;
    useLlmProcessing?: boolean;
  } = {},
) {
  const minLength = options.minLength ?? DEFAULT_WEB_EXTRACT_MIN_LENGTH;
  const maxChars = options.maxChars ?? DEFAULT_WEB_EXTRACT_MAX_CHARS;
  let processedWithLlm = 0;
  let truncated = 0;

  const results: WebExtractDocument[] = [];
  for (const document of documents) {
    const raw = cleanBase64Images(document.raw_content ?? document.content ?? "");
    if (!raw || document.error) {
      results.push({
        ...document,
        content: document.content ? cleanBase64Images(document.content) : document.content,
        raw_content: undefined,
      });
      continue;
    }

    let content = raw;
    if (options.useLlmProcessing !== false && raw.length >= minLength) {
      try {
        const summary = await summarizeLargeContent({
          content: raw,
          maxChars,
          signal: options.signal,
          title: document.title,
          url: document.url,
        });
        if (summary) {
          content = summary;
          processedWithLlm += 1;
        }
      } catch {
        content = raw;
      }
    }

    const capped = truncateText(cleanBase64Images(content), maxChars);
    if (capped.truncated) {
      truncated += 1;
    }

    results.push({
      ...document,
      content: capped.text,
      raw_content: undefined,
    });
  }

  return {
    processedWithLlm,
    results,
    truncated,
  };
}
