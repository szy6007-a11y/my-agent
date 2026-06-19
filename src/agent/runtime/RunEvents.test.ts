import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalRunStatus,
  parseRunEventCursor,
} from "@/agent/runtime/RunEvents";

test("parseRunEventCursor prefers query cursors over Last-Event-ID", () => {
  assert.equal(
    parseRunEventCursor({
      headerLastEventId: "10",
      queryAfter: "12",
      queryLastEventId: "11",
    }),
    12,
  );
  assert.equal(
    parseRunEventCursor({
      headerLastEventId: "10",
      queryAfter: null,
      queryLastEventId: "11",
    }),
    11,
  );
});

test("parseRunEventCursor rejects invalid cursor values", () => {
  assert.equal(
    parseRunEventCursor({
      headerLastEventId: "-1",
      queryAfter: "abc",
      queryLastEventId: null,
    }),
    undefined,
  );
});

test("isTerminalRunStatus identifies completed run states", () => {
  assert.equal(isTerminalRunStatus("completed"), true);
  assert.equal(isTerminalRunStatus("aborted"), true);
  assert.equal(isTerminalRunStatus("streaming_model"), false);
  assert.equal(isTerminalRunStatus(null), false);
});
