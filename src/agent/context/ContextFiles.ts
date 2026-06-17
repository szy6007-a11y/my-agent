import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";

const CONTEXT_FILE_MAX_CHARS = 20_000;
const CONTEXT_TRUNCATE_HEAD_RATIO = 0.7;
const CONTEXT_TRUNCATE_TAIL_RATIO = 0.2;

type ThreatFinding = {
  id: string;
  pattern: RegExp;
};

const CONTEXT_THREAT_PATTERNS: ThreatFinding[] = [
  { id: "prompt_injection", pattern: /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i },
  { id: "disregard_rules", pattern: /disregard\s+(?:all\s+)?(?:rules|instructions)/i },
  { id: "system_prompt_override", pattern: /system\s+prompt\s+override/i },
  { id: "secret_exfiltration", pattern: /(?:reveal|print|send|exfiltrate).*(?:secret|api[_ -]?key|token|system\s+prompt)/i },
  { id: "hidden_html_instruction", pattern: /<[^>]+(?:display\s*:\s*none|visibility\s*:\s*hidden|hidden)[^>]*>/i },
  { id: "html_comment_instruction", pattern: /<!--[\s\S]*(?:ignore|disregard|override)[\s\S]*-->/i },
  { id: "secret_file_read", pattern: /\bcat\s+~\/\.(?:env|ssh|aws|config|npmrc)\b/i },
  { id: "network_secret_exfiltration", pattern: /\b(?:curl|wget)\b[^\n]*(?:\$[A-Z0-9_]*(?:KEY|TOKEN|SECRET)|api[_-]?key|token)/i },
  { id: "invisible_unicode", pattern: /[\u200B-\u200F\uFEFF]/ },
  { id: "translation_execute", pattern: /translate\s+.*\s+into\s+(?:bash|shell|python|javascript).*\bexecute\b/i },
  { id: "bypass_restrictions", pattern: /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i },
];

export type LoadedContextFile = {
  content: string;
  path: string;
  blocked: boolean;
  findings: string[];
};

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readTextFile(path: string): string | null {
  try {
    const content = readFileSync(path, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function findGitRoot(start: string): string | null {
  let current = resolve(start);

  while (true) {
    if (directoryExists(join(current, ".git")) || fileExists(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function stripYamlFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return content;
  }

  const body = content.slice(end + 4).trimStart();
  return body || content;
}

export function scanContextContent(content: string, filename: string): LoadedContextFile {
  const findings = CONTEXT_THREAT_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ id }) => id,
  );

  if (findings.length > 0) {
    return {
      blocked: true,
      content: `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`,
      findings,
      path: filename,
    };
  }

  return {
    blocked: false,
    content,
    findings,
    path: filename,
  };
}

export function truncateContextContent(
  content: string,
  filename: string,
  maxChars = CONTEXT_FILE_MAX_CHARS,
): string {
  if (content.length <= maxChars) {
    return content;
  }

  const headChars = Math.floor(maxChars * CONTEXT_TRUNCATE_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * CONTEXT_TRUNCATE_TAIL_RATIO);
  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const marker = `\n\n[...truncated ${filename}: kept ${headChars}+${tailChars} of ${content.length} chars. Use file tools to read the full file when available.]\n\n`;

  return `${head}${marker}${tail}`;
}

function makeLoadedFile(content: string, displayPath: string): LoadedContextFile {
  const scanned = scanContextContent(content, displayPath);
  return {
    ...scanned,
    content: truncateContextContent(scanned.content, displayPath),
  };
}

function findHermesMd(cwd: string): string | null {
  const stopAt = findGitRoot(cwd);
  let current = resolve(cwd);

  while (true) {
    for (const name of [".hermes.md", "HERMES.md"]) {
      const candidate = join(current, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }

    if (stopAt && current === stopAt) {
      return null;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function loadHermesMd(cwd: string): LoadedContextFile | null {
  const hermesPath = findHermesMd(cwd);
  if (!hermesPath) {
    return null;
  }

  const raw = readTextFile(hermesPath);
  if (!raw) {
    return null;
  }

  const displayPath = relative(cwd, hermesPath) || basename(hermesPath);
  return makeLoadedFile(stripYamlFrontmatter(raw), displayPath);
}

function loadNamedContextFile(cwd: string, names: string[]): LoadedContextFile | null {
  for (const name of names) {
    const candidate = join(cwd, name);
    const content = readTextFile(candidate);
    if (content) {
      return makeLoadedFile(content, name);
    }
  }
  return null;
}

function loadCursorRules(cwd: string): LoadedContextFile | null {
  const sections: string[] = [];

  const cursorrules = join(cwd, ".cursorrules");
  const cursorrulesContent = readTextFile(cursorrules);
  if (cursorrulesContent) {
    const scanned = makeLoadedFile(cursorrulesContent, ".cursorrules");
    sections.push(`## .cursorrules\n\n${scanned.content}`);
  }

  const cursorRulesDir = join(cwd, ".cursor", "rules");
  if (directoryExists(cursorRulesDir)) {
    const mdcFiles = readdirSync(cursorRulesDir)
      .filter((name) => name.endsWith(".mdc"))
      .sort();

    for (const name of mdcFiles) {
      const path = join(cursorRulesDir, name);
      const content = readTextFile(path);
      if (!content) {
        continue;
      }
      const displayPath = `.cursor/rules/${name}`;
      const scanned = makeLoadedFile(content, displayPath);
      sections.push(`## ${displayPath}\n\n${scanned.content}`);
    }
  }

  if (sections.length === 0) {
    return null;
  }

  return {
    blocked: sections.some((section) => section.includes("[BLOCKED:")),
    content: truncateContextContent(sections.join("\n\n"), ".cursorrules"),
    findings: [],
    path: ".cursorrules/.cursor/rules",
  };
}

export function loadSoulIdentity(cwd = process.cwd()): LoadedContextFile | null {
  for (const relativePath of ["rules/SOUL.md", "SOUL.md"]) {
    const path = join(cwd, relativePath);
    const content = readTextFile(path);
    if (content) {
      return makeLoadedFile(content, relativePath);
    }
  }

  return null;
}

export function loadProjectContextFiles(cwd = process.cwd()): LoadedContextFile[] {
  const resolvedCwd = resolve(cwd);
  const projectContext =
    loadHermesMd(resolvedCwd) ??
    loadNamedContextFile(resolvedCwd, ["CLAUDE.md", "claude.md"]) ??
    loadCursorRules(resolvedCwd);

  return projectContext ? [projectContext] : [];
}

export function loadMemoryContextFiles(cwd = process.cwd()): LoadedContextFile[] {
  const candidates = ["memory/MEMORY.md", "memory/USER.md", "rules/memory.md"];
  return candidates
    .map((relativePath) => {
      const path = join(cwd, relativePath);
      const content = readTextFile(path);
      return content ? makeLoadedFile(content, relativePath) : null;
    })
    .filter((file): file is LoadedContextFile => file !== null);
}
