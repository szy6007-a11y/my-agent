# My Agent

ChatGPT-like web agent powered by DeepSeek.

## Development

```bash
docker compose up -d --build
```

Open:

- Web app: <http://localhost:3000>
- Health check: <http://localhost:3000/api/health>

Configuration is kept in `.env`. Keep secrets out of source control.

## Prototype Flow

The current prototype implements the first backend milestone from
`docs/AGENT_BACKEND_ARCHITECTURE.md`:

- `POST /api/agent/runs` creates a session/run, persists the user message, streams DeepSeek output, stores the assistant message, and appends run events.
- The frontend consumes normalized Agent events such as `run.accepted`, `context.built`, `assistant.delta`, `usage.updated`, and `run.completed`.
- Tool execution, approval flows, and context compaction are intentionally left for the next milestones.
