import { createHash } from "crypto";

export type SkillExecutionContext = "inline" | "fork";

export type SkillManifest = {
  allowedTools: string[];
  argumentHint?: string;
  context: SkillExecutionContext;
  description: string;
  disableModelInvocation: boolean;
  frontmatter: Record<string, string | string[] | boolean>;
  model?: string;
  name: string;
  paths: string[];
  platforms: string[];
  userInvocable: boolean;
  version?: string;
  whenToUse?: string;
};

export type SkillBundleFile = {
  content: Buffer;
  path: string;
};

export type SkillBundle = {
  files: SkillBundleFile[];
  identifier: string;
  metadata: Record<string, unknown>;
  source: "github";
  trustLevel: "builtin" | "trusted" | "community";
};

export type ParsedSkillBundle = SkillBundle & {
  contentHash: string;
  manifest: SkillManifest;
  skillFile: SkillBundleFile;
};

type FrontmatterValue = string | string[] | boolean;

function splitFrontmatter(raw: string): { body: string; frontmatter: string } {
  if (!raw.startsWith("---")) {
    return { body: raw, frontmatter: "" };
  }

  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { body: raw, frontmatter: "" };
  }

  return {
    body: raw.slice(end + 4),
    frontmatter: raw.slice(3, end),
  };
}

function parseScalar(raw: string): string | boolean {
  const value = raw.trim().replace(/^['"]|['"]$/g, "");
  if (/^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  return value;
}

function parseInlineList(raw: string): string[] | null {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return null;
  }

  return value
    .slice(1, -1)
    .split(",")
    .map((item) => String(parseScalar(item)).trim())
    .filter(Boolean);
}

export function parseSkillFrontmatter(raw: string): Record<string, FrontmatterValue> {
  const { frontmatter } = splitFrontmatter(raw);
  const parsed: Record<string, FrontmatterValue> = {};
  const lines = frontmatter.split(/\r?\n/);
  let pendingListKey: string | null = null;

  for (const line of lines) {
    const listMatch = /^\s*-\s*(.+)\s*$/.exec(line);
    if (pendingListKey && listMatch) {
      const current = parsed[pendingListKey];
      const list = Array.isArray(current) ? current : [];
      parsed[pendingListKey] = [...list, String(parseScalar(listMatch[1]))];
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      pendingListKey = null;
      continue;
    }

    const [, rawKey, rawValue] = match;
    const key = rawKey.toLowerCase();
    if (!rawValue.trim()) {
      parsed[key] = [];
      pendingListKey = key;
      continue;
    }

    parsed[key] = parseInlineList(rawValue) ?? parseScalar(rawValue);
    pendingListKey = null;
  }

  return parsed;
}

function asString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asBoolean(value: FrontmatterValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function descriptionFromBody(body: string): string {
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return paragraph ? paragraph.slice(0, 240) : "";
}

export function parseSkillManifest(raw: string, fallbackName: string): SkillManifest {
  const { body } = splitFrontmatter(raw);
  const frontmatter = parseSkillFrontmatter(raw);
  const contextValue = asString(frontmatter.context)?.toLowerCase();
  const disableModelInvocation = asBoolean(frontmatter["disable-model-invocation"], false);

  return {
    allowedTools: [
      ...new Set([
        ...asStringArray(frontmatter["allowed-tools"]),
        ...asStringArray(frontmatter.tools),
      ]),
    ],
    argumentHint: asString(frontmatter["argument-hint"]),
    context: contextValue === "fork" ? "fork" : "inline",
    description:
      asString(frontmatter.description) ??
      asString(frontmatter.when_to_use) ??
      descriptionFromBody(body),
    disableModelInvocation,
    frontmatter,
    model: asString(frontmatter.model),
    name: asString(frontmatter.name) ?? fallbackName,
    paths: asStringArray(frontmatter.paths),
    platforms: asStringArray(frontmatter.platforms),
    userInvocable: asBoolean(frontmatter["user-invocable"], true),
    version: asString(frontmatter.version),
    whenToUse: asString(frontmatter.when_to_use) ?? asString(frontmatter["when-to-use"]),
  };
}

export function hashSkillFiles(files: SkillBundleFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
