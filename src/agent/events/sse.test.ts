import assert from "node:assert/strict";
import test from "node:test";

import { encodeAgentEvent } from "@/agent/events/sse";

test("encodeAgentEvent includes an SSE id when provided", () => {
  assert.equal(
    encodeAgentEvent(
      {
        type: "run.started",
        runId: "run_1",
      },
      { id: 42 },
    ),
    'id: 42\nevent: run.started\ndata: {"type":"run.started","runId":"run_1"}\n\n',
  );
});

test("encodeAgentEvent omits the SSE id for unsequenced events", () => {
  assert.equal(
    encodeAgentEvent({
      type: "run.aborted",
      runId: "run_1",
      reason: "client_aborted",
    }),
    'event: run.aborted\ndata: {"type":"run.aborted","runId":"run_1","reason":"client_aborted"}\n\n',
  );
});
