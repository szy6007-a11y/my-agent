import {
  configuredFallbackProvider,
  configuredProvider,
  hasExplicitProvider,
} from "@/agent/web/env";
import { createBuiltInWebProviders } from "@/agent/web/providers";
import type { WebCapability, WebProviderName, WebSearchProvider } from "@/agent/web/types";

const LEGACY_PREFERENCE: WebProviderName[] = [
  "firecrawl",
  "parallel",
  "tavily",
  "exa",
  "searxng",
  "brave-free",
  "ddgs",
];

function supports(provider: WebSearchProvider, capability: WebCapability): boolean {
  return capability === "search" ? provider.supportsSearch() : provider.supportsExtract();
}

function isAvailable(provider: WebSearchProvider): boolean {
  try {
    return provider.isAvailable();
  } catch {
    return false;
  }
}

export class WebSearchRegistry {
  private readonly providers = new Map<WebProviderName, WebSearchProvider>();

  constructor(providers: WebSearchProvider[] = createBuiltInWebProviders()) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: WebSearchProvider) {
    this.providers.set(provider.name, provider);
  }

  list(): WebSearchProvider[] {
    return [...this.providers.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string | undefined): WebSearchProvider | undefined {
    if (!name) {
      return undefined;
    }
    return this.providers.get(name.trim().toLowerCase() as WebProviderName);
  }

  getActiveProvider(capability: WebCapability): WebSearchProvider | null {
    const explicitName = configuredProvider(capability);
    const explicit = this.get(explicitName);
    if (explicit && supports(explicit, capability)) {
      return explicit;
    }

    const available = this.list().filter(
      (provider) => supports(provider, capability) && isAvailable(provider),
    );
    if (available.length === 1) {
      return available[0];
    }

    for (const name of LEGACY_PREFERENCE) {
      const provider = this.get(name);
      if (provider && supports(provider, capability) && isAvailable(provider)) {
        return provider;
      }
    }

    return null;
  }

  getFallbackProvider(
    capability: WebCapability,
    primary?: WebSearchProvider | null,
  ): WebSearchProvider | null {
    const fallbackName = configuredFallbackProvider(capability);
    const fallback = this.get(fallbackName);
    if (!fallback || fallback.name === primary?.name || !supports(fallback, capability)) {
      return null;
    }
    return isAvailable(fallback) ? fallback : null;
  }

  hasEnabledTool(capability: WebCapability): boolean {
    const active = this.getActiveProvider(capability);
    const fallback = this.getFallbackProvider(capability, active);
    if (!active && !fallback) {
      return false;
    }
    return Boolean((active && (isAvailable(active) || hasExplicitProvider(capability))) || fallback);
  }
}

export function createDefaultWebSearchRegistry() {
  return new WebSearchRegistry();
}
