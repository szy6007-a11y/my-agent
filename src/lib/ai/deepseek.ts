import { observeOpenAI, type LangfuseConfig } from "@langfuse/openai";
import OpenAI from "openai";

import { serverEnv } from "@/lib/env";
import { ensureLangfuseTracing, isLangfuseTracingEnabled } from "@/lib/langfuse";

const deepseek = new OpenAI({
  apiKey: serverEnv.DEEPSEEK_API_KEY,
  baseURL: serverEnv.DEEPSEEK_BASE_URL,
});

export function getDeepSeekClient(langfuseConfig?: LangfuseConfig) {
  ensureLangfuseTracing();

  if (!isLangfuseTracingEnabled()) {
    return deepseek;
  }

  return observeOpenAI(deepseek, langfuseConfig);
}

export const deepseekModels = {
  default: serverEnv.DEEPSEEK_MODEL_DEFAULT,
  pro: serverEnv.DEEPSEEK_MODEL_PRO,
};
