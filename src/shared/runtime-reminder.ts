export const SYSTEM_REMINDER_OPEN_TAG = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE_TAG = "</system-reminder>";
export const TRUSTED_SYSTEM_REMINDER_SENTINEL = "[my-agent-runtime-system-reminder]";

function splitTrustedRuntimeReminder(content: string): { prefix: string; rest: string } {
  if (!content.startsWith(SYSTEM_REMINDER_OPEN_TAG)) {
    return { prefix: "", rest: content };
  }

  const closeIndex = content.indexOf(SYSTEM_REMINDER_CLOSE_TAG);
  if (closeIndex < 0) {
    return { prefix: "", rest: content };
  }

  const end = closeIndex + SYSTEM_REMINDER_CLOSE_TAG.length;
  const prefix = content.slice(0, end);
  if (!prefix.includes(TRUSTED_SYSTEM_REMINDER_SENTINEL)) {
    return { prefix: "", rest: content };
  }

  return { prefix, rest: content.slice(end) };
}

export function hasTrustedRuntimeReminder(content: string): boolean {
  return splitTrustedRuntimeReminder(content).prefix.length > 0;
}

export function stripTrustedRuntimeReminder(content: string): string {
  return splitTrustedRuntimeReminder(content).rest.trimStart();
}
