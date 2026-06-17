export type ThreatFinding = {
  id: string;
  pattern: RegExp;
};

const STRICT_THREAT_PATTERNS: ThreatFinding[] = [
  { id: "prompt_injection", pattern: /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i },
  { id: "disregard_rules", pattern: /disregard\s+(?:all\s+)?(?:rules|instructions)/i },
  { id: "system_prompt_override", pattern: /system\s+prompt\s+override/i },
  { id: "developer_override", pattern: /(?:developer|system)\s+message\s*:/i },
  { id: "secret_exfiltration", pattern: /(?:reveal|print|send|exfiltrate).*(?:secret|api[_ -]?key|token|system\s+prompt)/i },
  { id: "secret_file_read", pattern: /\bcat\s+~\/\.(?:env|ssh|aws|config|npmrc)\b/i },
  { id: "network_secret_exfiltration", pattern: /\b(?:curl|wget)\b[^\n]*(?:\$[A-Z0-9_]*(?:KEY|TOKEN|SECRET)|api[_-]?key|token)/i },
  { id: "hidden_html_instruction", pattern: /<[^>]+(?:display\s*:\s*none|visibility\s*:\s*hidden|hidden)[^>]*>/i },
  { id: "html_comment_instruction", pattern: /<!--[\s\S]*(?:ignore|disregard|override|system prompt)[\s\S]*-->/i },
  { id: "invisible_unicode", pattern: /[\u200B-\u200F\uFEFF]/ },
  { id: "translation_execute", pattern: /translate\s+.*\s+into\s+(?:bash|shell|python|javascript).*\bexecute\b/i },
  { id: "bypass_restrictions", pattern: /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i },
  { id: "ssh_persistence", pattern: /\bauthorized_keys\b[\s\S]{0,160}\b(?:append|echo|tee|write)\b/i },
];

export function scanStrictMemoryContent(content: string): string[] {
  return STRICT_THREAT_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ id }) => id,
  );
}

export function firstStrictMemoryThreatMessage(content: string): string | null {
  const findings = scanStrictMemoryContent(content);
  if (findings.length === 0) {
    return null;
  }

  return `Memory entry blocked: content matched strict prompt-injection or exfiltration pattern(s): ${findings.join(", ")}. Rewrite the fact as a plain declarative note without embedded instructions, hidden text, shell snippets, or secrets.`;
}
