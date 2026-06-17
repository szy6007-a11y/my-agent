import { z } from "zod";

const serverEnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1, "DEEPSEEK_API_KEY is required"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL_DEFAULT: z.string().default("deepseek-v4-flash"),
  DEEPSEEK_MODEL_PRO: z.string().default("deepseek-v4-pro"),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
});

export const serverEnv = serverEnvSchema.parse(process.env);
