import type { WebCapability, WebProviderName } from "@/agent/web/types";

const PROVIDER_NAMES = new Set<WebProviderName>([
  "brave-free",
  "ddgs",
  "exa",
  "firecrawl",
  "parallel",
  "searxng",
  "tavily",
]);

export const DEFAULT_WEB_SEARCH_LIMIT = 5;
export const MAX_WEB_SEARCH_LIMIT = 100;
export const DEFAULT_WEB_TIMEOUT_MS = 30_000;
export const DEFAULT_WEB_EXTRACT_TIMEOUT_MS = 60_000;
export const DEFAULT_WEB_EXTRACT_MIN_LENGTH = 5_000;
export const DEFAULT_WEB_EXTRACT_MAX_CHARS = 5_000;
export const MAX_WEB_EXTRACT_URLS = 5;
export const MAX_WEB_TOOL_RESULT_CHARS = 100_000;

export function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function envFlag(name: string, fallback = false): boolean {
  const value = envValue(name).toLowerCase();
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = envValue(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function configuredProvider(capability: WebCapability): WebProviderName | undefined {
  const specific =
    capability === "search" ? envValue("WEB_SEARCH_PROVIDER") : envValue("WEB_EXTRACT_PROVIDER");
  const shared = envValue("WEB_PROVIDER");
  const raw = (specific || shared).toLowerCase();
  return PROVIDER_NAMES.has(raw as WebProviderName) ? (raw as WebProviderName) : undefined;
}

export function hasExplicitProvider(capability: WebCapability): boolean {
  return Boolean(configuredProvider(capability));
}

export function configuredWebSearchLimit(): number {
  return envInt(
    "WEB_SEARCH_DEFAULT_LIMIT",
    DEFAULT_WEB_SEARCH_LIMIT,
    1,
    MAX_WEB_SEARCH_LIMIT,
  );
}

export function configuredWebTimeoutMs(): number {
  return envInt("WEB_SEARCH_TIMEOUT_MS", DEFAULT_WEB_TIMEOUT_MS, 1_000, 120_000);
}

export function configuredWebExtractTimeoutMs(): number {
  return envInt("WEB_EXTRACT_TIMEOUT_MS", DEFAULT_WEB_EXTRACT_TIMEOUT_MS, 1_000, 180_000);
}

export function configuredWebExtractMinLength(): number {
  return envInt("WEB_EXTRACT_MIN_LENGTH", DEFAULT_WEB_EXTRACT_MIN_LENGTH, 0, 200_000);
}

export function configuredWebExtractMaxChars(): number {
  return envInt("WEB_EXTRACT_MAX_CHARS", DEFAULT_WEB_EXTRACT_MAX_CHARS, 1_000, 100_000);
}
