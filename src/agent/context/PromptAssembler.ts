import { readFileSync } from "fs";
import { join, resolve } from "path";

import {
  type LoadedContextFile,
  loadMemoryContextFiles,
  loadProjectContextFiles,
  loadSoulIdentity,
} from "@/agent/context/ContextFiles";
import { buildSkillIndex, renderSkillIndex } from "@/agent/context/SkillIndex";

export type PromptTierName = "stable" | "context" | "volatile";

export type PromptSection = {
  content: string;
  source: string;
  status?: string;
  tag: string;
  tier: PromptTierName;
};

export type PromptAssembly = {
  prompt: string;
  sections: PromptSection[];
  tiers: Record<PromptTierName, string>;
};

export type PromptAssemblerInput = {
  availableTools?: string[];
  cwd?: string;
  model?: string;
  now?: Date;
  platform?: "webui" | "api";
  provider?: string;
  sessionId?: string;
  timeZone?: string;
};

const PROMPT_VERSION = "2026-06-17.hermes-style-v1";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function promptFilePath(filename: string): string {
  return join(process.cwd(), "rules", "prompts", "system", filename);
}

function readPromptFragment(filename: string): PromptSection {
  const path = promptFilePath(filename);
  try {
    return {
      content: readFileSync(path, "utf8").trim(),
      source: `rules/prompts/system/${filename}`,
      tag: filename.replace(/\.md$/, "").replace(/-/g, "_"),
      tier: "stable",
    };
  } catch {
    return {
      content: `[MISSING PROMPT FRAGMENT: rules/prompts/system/${filename}]`,
      source: `rules/prompts/system/${filename}`,
      status: "missing",
      tag: filename.replace(/\.md$/, "").replace(/-/g, "_"),
      tier: "stable",
    };
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderSection(section: PromptSection): string {
  const attrs = [
    `source="${escapeAttribute(section.source)}"`,
    section.status ? `status="${escapeAttribute(section.status)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<${section.tag} ${attrs}>\n${section.content.trim()}\n</${section.tag}>`;
}

function renderTier(tag: string, sections: PromptSection[]): string {
  if (sections.length === 0) {
    return `<${tag} status="empty">\n</${tag}>`;
  }

  return `<${tag}>\n${sections.map(renderSection).join("\n\n")}\n</${tag}>`;
}

function formatDateOnly(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "long",
      timeZone,
      weekday: "long",
      year: "numeric",
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "long",
      timeZone: "UTC",
      weekday: "long",
      year: "numeric",
    }).format(now);
  }
}

function renderLoadedFile(file: LoadedContextFile): string {
  const attrs = [
    `path="${escapeAttribute(file.path)}"`,
    file.blocked ? `status="blocked"` : `status="loaded"`,
    file.findings.length > 0 ? `findings="${escapeAttribute(file.findings.join(","))}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<context_file ${attrs}>\n${file.content.trim()}\n</context_file>`;
}

function buildAvailableToolsSection(availableTools: string[] | undefined): PromptSection {
  const tools = [...new Set(availableTools ?? [])].sort();

  if (tools.length === 0) {
    return {
      content:
        "No model-callable tools are enabled in this MVP run. Answer from conversation context and reasoning only. Do not pretend that file, shell, web, MCP, memory-write, or skill-loading tools are available.",
      source: "runtime",
      status: "none",
      tag: "available_tools",
      tier: "stable",
    };
  }

  return {
    content: tools.map((tool) => `- ${tool}`).join("\n"),
    source: "runtime",
    status: "available",
    tag: "available_tools",
    tier: "stable",
  };
}

function buildSkillsSection(cwd: string): PromptSection {
  const index = buildSkillIndex(cwd);
  const status = index.entries.length > 0 ? "indexed" : "empty";
  const loadingStatus =
    "Full skill loading is not enabled in this MVP yet. Use this index only as planning context; do not claim to have read a full skill body.";

  return {
    content: `${renderSkillIndex(index)}\n\n${loadingStatus}`,
    source: index.roots.length > 0 ? index.roots.join(", ") : "./skills, ./rules/skills",
    status,
    tag: "available_skills",
    tier: "stable",
  };
}

function buildProjectContextSection(cwd: string): PromptSection {
  const files = loadProjectContextFiles(cwd);

  if (files.length === 0) {
    return {
      content:
        "No project context file was loaded. Discovery checked .hermes.md/HERMES.md up to the git root, then AGENTS.md, CLAUDE.md, .cursorrules, and .cursor/rules/*.mdc in the current working directory.",
      source: cwd,
      status: "empty",
      tag: "project_context",
      tier: "context",
    };
  }

  return {
    content:
      "The following project context files have been loaded and should be followed when relevant.\n\n" +
      files.map(renderLoadedFile).join("\n\n"),
    source: cwd,
    status: "loaded",
    tag: "project_context",
    tier: "context",
  };
}

function buildMemorySection(cwd: string): PromptSection {
  const files = loadMemoryContextFiles(cwd);

  if (files.length === 0) {
    return {
      content:
        "Persistent memory storage is not enabled for this MVP run, and no memory context files were found. Do not claim to remember facts across sessions unless they are present in this conversation.",
      source: "./memory, ./rules/memory.md",
      status: "disabled",
      tag: "memory",
      tier: "volatile",
    };
  }

  return {
    content: files.map(renderLoadedFile).join("\n\n"),
    source: files.map((file) => file.path).join(", "),
    status: "loaded",
    tag: "memory",
    tier: "volatile",
  };
}

function buildEnvironmentSection(input: RequiredPromptInput): PromptSection {
  const lines = [
    `Runtime surface: ${input.platform === "webui" ? "browser Web UI" : "API"}`,
    "Runtime boundary: Next.js server-side route handler",
    `Working directory: ${input.cwd}`,
    `Host platform: ${process.platform}`,
    `Node.js: ${process.version}`,
    input.provider ? `Provider: ${input.provider}` : "",
    input.model ? `Model: ${input.model}` : "",
  ].filter(Boolean);

  return {
    content: lines.join("\n"),
    source: "runtime",
    tag: "environment_context",
    tier: "volatile",
  };
}

function buildDateSection(input: RequiredPromptInput): PromptSection {
  const date = formatDateOnly(input.now, input.timeZone);
  const lines = [
    `Conversation started: ${date}`,
    `Time zone: ${input.timeZone}`,
    input.sessionId ? `Session ID: ${input.sessionId}` : "",
  ].filter(Boolean);

  return {
    content: lines.join("\n"),
    source: "runtime",
    tag: "conversation_metadata",
    tier: "volatile",
  };
}

type RequiredPromptInput = Required<
  Pick<PromptAssemblerInput, "cwd" | "now" | "platform" | "timeZone">
> &
  Omit<PromptAssemblerInput, "cwd" | "now" | "platform" | "timeZone">;

function normalizeInput(input: PromptAssemblerInput): RequiredPromptInput {
  return {
    ...input,
    cwd: resolve(input.cwd ?? process.cwd()),
    now: input.now ?? new Date(),
    platform: input.platform ?? "webui",
    timeZone: input.timeZone ?? process.env.TZ ?? DEFAULT_TIME_ZONE,
  };
}

export class PromptAssembler {
  assemble(rawInput: PromptAssemblerInput = {}): PromptAssembly {
    const input = normalizeInput(rawInput);
    const soulIdentity = loadSoulIdentity(input.cwd);

    const identity = soulIdentity
      ? ({
          content: soulIdentity.content,
          source: soulIdentity.path,
          status: soulIdentity.blocked ? "blocked" : "loaded",
          tag: "identity",
          tier: "stable",
        } satisfies PromptSection)
      : ({
          ...readPromptFragment("identity.md"),
          tag: "identity",
        } satisfies PromptSection);

    const stable: PromptSection[] = [
      identity,
      { ...readPromptFragment("runtime-guidance.md"), tag: "runtime_guidance" },
      { ...readPromptFragment("tool-guidance.md"), tag: "tool_guidance" },
      buildAvailableToolsSection(input.availableTools),
      { ...readPromptFragment("skills-guidance.md"), tag: "skills_guidance" },
      buildSkillsSection(input.cwd),
      { ...readPromptFragment("platform-webui.md"), tag: "platform_guidance" },
    ];

    const context: PromptSection[] = [buildProjectContextSection(input.cwd)];

    const volatile: PromptSection[] = [
      { ...readPromptFragment("memory-guidance.md"), tag: "memory_guidance", tier: "volatile" },
      buildMemorySection(input.cwd),
      buildEnvironmentSection(input),
      buildDateSection(input),
    ];

    const tiers = {
      stable: renderTier("stable_context", stable),
      context: renderTier("project_context_layer", context),
      volatile: renderTier("volatile_context", volatile),
    };

    const prompt = `<system_prompt version="${PROMPT_VERSION}">\n${tiers.stable}\n\n${tiers.context}\n\n${tiers.volatile}\n</system_prompt>`;

    return {
      prompt,
      sections: [...stable, ...context, ...volatile],
      tiers,
    };
  }
}
