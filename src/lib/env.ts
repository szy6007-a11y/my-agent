import { z } from "zod";

const serverEnvSchema = z.object({
  APP_ENV: z.enum(["dev", "sit", "prod"]).default("dev"),
  APP_SESSION_SECRET: z.string().min(32).optional(),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BETA_INVITE_CODES: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1, "DEEPSEEK_API_KEY is required"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL_DEFAULT: z.string().default("deepseek-v4-flash"),
  DEEPSEEK_MODEL_PRO: z.string().default("deepseek-v4-pro"),
  DATABASE_URL: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.url().default("https://cloud.langfuse.com"),
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_TRACING_ENVIRONMENT: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
});

export const serverEnv = serverEnvSchema.parse(process.env);
