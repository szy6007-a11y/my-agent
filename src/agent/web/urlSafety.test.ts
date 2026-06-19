import assert from "node:assert/strict";
import test from "node:test";

import {
  isBlockedHostnameResolutionAddress,
  validateExternalUrl,
} from "@/agent/web/urlSafety";

test("hostname DNS safety allows synthetic 198.18 proxy mappings", () => {
  assert.equal(isBlockedHostnameResolutionAddress("198.18.0.82"), false);
  assert.equal(isBlockedHostnameResolutionAddress("10.0.0.5"), true);
  assert.equal(isBlockedHostnameResolutionAddress("127.0.0.1"), true);
});

test("URL safety still blocks benchmark range IP literals", async () => {
  const result = await validateExternalUrl("https://198.18.0.82/path");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /private or internal/);
  }
});
