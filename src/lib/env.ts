import { z } from "zod";

function optionalEnv<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );
}

const webProviderSchema = z.enum([
  "firecrawl",
  "parallel",
  "tavily",
  "exa",
  "searxng",
  "brave-free",
  "ddgs",
]);

const serverEnvSchema = z.object({
  APP_ENV: z.enum(["dev", "sit", "prod"]).default("dev"),
  APP_SESSION_SECRET: z.string().min(32).optional(),
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BETA_INVITE_CODES: z.string().min(1).optional(),
  CONTEXT_COMPRESSION_THRESHOLD_PERCENT: z.coerce.number().positive().max(1).default(0.5),
  DEEPSEEK_API_KEY: z.string().min(1, "DEEPSEEK_API_KEY is required"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(64_000),
  DEEPSEEK_MODEL_DEFAULT: z.string().default("deepseek-v4-pro"),
  DEEPSEEK_MODEL_PRO: z.string().default("deepseek-v4-pro"),
  DATABASE_URL: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.url().default("https://cloud.langfuse.com"),
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_TRACING_ENVIRONMENT: z.string().min(1).optional(),
  MEMORY_CHAR_LIMIT: z.coerce.number().int().positive().optional(),
  MEMORY_DIR: z.string().min(1).optional(),
  MEMORY_REVIEW_INTERVAL: z.coerce.number().int().min(0).default(10),
  SKILL_REVIEW_INTERVAL: z.coerce.number().int().min(0).default(10),
  REDIS_URL: z.string().min(1).optional(),
  ARTIFACT_STORAGE_DIR: optionalEnv(z.string().min(1)),
  FILE_WORKSPACE_DIR: optionalEnv(z.string().min(1)),
  SKILL_GITHUB_TOKEN: optionalEnv(z.string().min(1)),
  SKILL_MAX_TOTAL_BYTES: optionalEnv(
    z.coerce.number().int().min(1024 * 1024).max(50 * 1024 * 1024),
  ),
  SKILL_STORAGE_DIR: optionalEnv(z.string().min(1)),
  USER_MEMORY_CHAR_LIMIT: z.coerce.number().int().positive().optional(),
  WEB_ALLOW_PRIVATE_URLS: optionalEnv(z.enum(["true", "false"])),
  WEB_DDGS_ENABLED: optionalEnv(z.enum(["true", "false"])),
  WEB_EXTRACT_MAX_CHARS: optionalEnv(z.coerce.number().int().positive()),
  WEB_EXTRACT_MIN_LENGTH: optionalEnv(z.coerce.number().int().min(0)),
  WEB_EXTRACT_PROVIDER: optionalEnv(webProviderSchema),
  WEB_EXTRACT_SUMMARIZER_MODEL: optionalEnv(z.string().min(1)),
  WEB_EXTRACT_TIMEOUT_MS: optionalEnv(z.coerce.number().int().positive()),
  WEB_PROVIDER: optionalEnv(webProviderSchema),
  WEB_SEARCH_DEFAULT_LIMIT: optionalEnv(z.coerce.number().int().positive()),
  WEB_SEARCH_FALLBACK_PROVIDER: optionalEnv(webProviderSchema),
  WEB_SEARCH_GITHUB_ENRICH_LIMIT: optionalEnv(z.coerce.number().int().min(0).max(20)),
  WEB_SEARCH_PROVIDER: optionalEnv(webProviderSchema),
  WEB_SEARCH_TIMEOUT_MS: optionalEnv(z.coerce.number().int().positive()),
  BRAVE_SEARCH_API_KEY: optionalEnv(z.string().min(1)),
  EXA_API_KEY: optionalEnv(z.string().min(1)),
  FIRECRAWL_API_KEY: optionalEnv(z.string().min(1)),
  FIRECRAWL_API_URL: optionalEnv(z.url()),
  GITHUB_TOKEN: optionalEnv(z.string().min(1)),
  PARALLEL_API_KEY: optionalEnv(z.string().min(1)),
  SEARXNG_URL: optionalEnv(z.url()),
  TAVILY_API_KEY: optionalEnv(z.string().min(1)),
  TAVILY_BASE_URL: optionalEnv(z.url()),
});

export const serverEnv = serverEnvSchema.parse(process.env);
