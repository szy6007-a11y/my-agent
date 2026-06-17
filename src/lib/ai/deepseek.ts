import OpenAI from "openai";

import { serverEnv } from "@/lib/env";

export const deepseek = new OpenAI({
  apiKey: serverEnv.DEEPSEEK_API_KEY,
  baseURL: serverEnv.DEEPSEEK_BASE_URL,
});

export const deepseekModels = {
  default: serverEnv.DEEPSEEK_MODEL_DEFAULT,
  pro: serverEnv.DEEPSEEK_MODEL_PRO,
};
