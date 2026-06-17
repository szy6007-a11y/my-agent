import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { envFlag } from "@/agent/web/env";

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog"]);
const ALWAYS_BLOCKED_IPV4 = new Set([
  "100.100.100.200",
  "169.254.169.253",
  "169.254.169.254",
  "169.254.170.2",
]);
const SECRET_PATTERN =
  /(?:^|[?&#/])(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|password|secret|token)=|(?:sk|sk-lf|pk-lf|gh[pousr]|xox[baprs]|tvly)-[-_A-Za-z0-9.]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}/i;

type UrlSafetyResult =
  | {
      ok: false;
      reason: string;
      url?: string;
    }
  | {
      ok: true;
      url: string;
    };

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    a >= 240 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function ipv4FromMappedIpv6(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) {
    return undefined;
  }
  const tail = lower.slice("::ffff:".length);
  return isIP(tail) === 4 ? tail : undefined;
}

function isBlockedIp(ip: string): boolean {
  const mapped = ipv4FromMappedIpv6(ip);
  if (mapped) {
    return isBlockedIp(mapped);
  }

  if (isIP(ip) === 4) {
    if (ALWAYS_BLOCKED_IPV4.has(ip)) {
      return true;
    }
    return !envFlag("WEB_ALLOW_PRIVATE_URLS") && isPrivateIpv4(ip);
  }

  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::" || lower.startsWith("fe80:") || lower === "fd00:ec2::254") {
    return true;
  }
  if (!envFlag("WEB_ALLOW_PRIVATE_URLS") && (lower.startsWith("fc") || lower.startsWith("fd"))) {
    return true;
  }
  return false;
}

export function normalizeUrlForRequest(raw: string): string {
  const trimmed = raw.trim().replace(/^(https?:\/\/)\s+/i, "$1");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return url.toString();
}

export function urlContainsSecret(raw: string): boolean {
  try {
    return SECRET_PATTERN.test(raw) || SECRET_PATTERN.test(decodeURIComponent(raw));
  } catch {
    return SECRET_PATTERN.test(raw);
  }
}

export async function validateExternalUrl(raw: string): Promise<UrlSafetyResult> {
  let normalized: string;
  let parsed: URL;
  try {
    normalized = normalizeUrlForRequest(raw);
    parsed = new URL(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL.";
    return { ok: false, reason: message };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "Blocked: URL contains username or password credentials.",
      url: normalized,
    };
  }
  if (urlContainsSecret(raw) || urlContainsSecret(normalized)) {
    return {
      ok: false,
      reason: "Blocked: URL contains what appears to be an API key or token.",
      url: normalized,
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      reason: "Blocked: URL targets an internal metadata hostname.",
      url: normalized,
    };
  }

  if (isIP(hostname)) {
    return isBlockedIp(hostname) ?
        {
          ok: false,
          reason: "Blocked: URL targets a private or internal network address.",
          url: normalized,
        }
      : { ok: true, url: normalized };
  }

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: false });
    if (addresses.length === 0) {
      return { ok: false, reason: "Blocked: URL hostname did not resolve.", url: normalized };
    }
    for (const address of addresses) {
      if (isBlockedIp(address.address)) {
        return {
          ok: false,
          reason: "Blocked: URL resolves to a private or internal network address.",
          url: normalized,
        };
      }
    }
  } catch {
    return { ok: false, reason: "Blocked: URL DNS resolution failed.", url: normalized };
  }

  return { ok: true, url: normalized };
}

export function domainMatches(url: string, domains: string[]): boolean {
  if (domains.length === 0) {
    return true;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((domain) => {
      const normalized = domain.trim().toLowerCase().replace(/^\*\./, "");
      return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
    });
  } catch {
    return false;
  }
}
