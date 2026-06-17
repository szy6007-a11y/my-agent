# Technical Architecture Diagram

调研日期：2026-06-17  
目标：ChatGPT-like Web Agent，前端仿 ChatGPT 信息架构，后端封装 DeepSeek API Key、自研 Agent Loop、工具、知识库与安全治理。

补充：面向“仿 Claude Code”的 Agent 后端运行时设计见 [AGENT_BACKEND_ARCHITECTURE.md](./AGENT_BACKEND_ARCHITECTURE.md)。

## Recommended Architecture

```mermaid
flowchart LR
  User["User Browser"]

  subgraph FE["Frontend: Next.js App Router + React + TypeScript"]
    Shell["ChatGPT-like App Shell<br/>Sidebar / Chat Area / Composer"]
    ChatUI["Streaming Chat UI<br/>Markdown / Code / Citations / Tool Status"]
    UploadUI["Attachment & File Upload UI"]
    ProjectUI["Projects / Library / Search"]
  end

  subgraph BFF["Backend for Frontend: Next.js Route Handlers"]
    Auth["Auth Middleware<br/>Auth.js or Supabase Auth"]
    ChatAPI["POST /api/chat/runs<br/>SSE Stream Adapter"]
    ConvAPI["Conversation / Project / Agent APIs"]
    FileAPI["File Upload / Knowledge APIs"]
    Policy["Rate Limit / Quota / Tool Policy"]
  end

  subgraph Agent["Agent Backend: Custom TypeScript Agent Loop"]
    Runtime["Agent Runtime<br/>Instructions / Model Config / State Builder"]
    Loop["Tool Calling Loop<br/>max iterations / retry / abort"]
    ToolRouter["Tool Router<br/>Function Tools / MCP Gateway / Approvals"]
    Guardrails["Guardrails & Human Review"]
    StreamMap["DeepSeek SSE Chunks -> UI Events"]
  end

  subgraph DeepSeek["DeepSeek Platform"]
    ChatCompletions["/chat/completions<br/>deepseek-v4-flash / deepseek-v4-pro"]
    Capabilities["Streaming / Tool Calls / JSON Output<br/>Thinking Mode / Context Caching"]
  end

  subgraph Tools["Application-side Tools"]
    WebSearch["Web Search Tool<br/>Tavily / Exa / Brave / SerpAPI / self-hosted"]
    KnowledgeTool["Knowledge Search Tool<br/>pgvector / Qdrant / Weaviate"]
    BusinessTools["Business Function Tools<br/>Internal APIs / DB / CRM"]
    Sandbox["Optional Sandbox<br/>Code / data processing"]
    MCP["Optional MCP Gateway<br/>Drive / GitHub / Notion / Slack"]
  end

  subgraph Data["Data Plane"]
    Postgres["Postgres<br/>Users / Conversations / Messages / Runs / Audit"]
    ObjectStore["Object Storage<br/>Attachments / Exports / Artifacts"]
    Vector["Vector Index<br/>Supabase pgvector first"]
    Redis["Redis or Durable Store<br/>Locks / Rate Limits / Short-lived State"]
  end

  subgraph Async["Async & Operations"]
    Jobs["Durable Jobs<br/>Inngest / Trigger.dev / Temporal"]
    Observability["Langfuse + OpenTelemetry<br/>Trace / Cost / Latency / Eval Scores"]
    Evals["Promptfoo CI<br/>Regression / Red Team / RAG Quality"]
    Alerts["Monitoring & Alerts"]
  end

  User --> Shell
  Shell --> ChatUI
  Shell --> UploadUI
  Shell --> ProjectUI

  ChatUI --> ChatAPI
  UploadUI --> FileAPI
  ProjectUI --> ConvAPI

  ChatAPI --> Auth
  ConvAPI --> Auth
  FileAPI --> Auth
  ChatAPI --> Policy
  Policy --> Runtime

  Runtime --> Loop
  Loop --> Guardrails
  Loop --> ChatCompletions
  ChatCompletions --> Capabilities
  ChatCompletions --> StreamMap
  Loop --> ToolRouter
  ToolRouter --> WebSearch
  ToolRouter --> KnowledgeTool
  ToolRouter --> BusinessTools
  ToolRouter --> Sandbox
  ToolRouter --> MCP
  Guardrails --> Loop
  StreamMap --> ChatAPI
  ChatAPI --> ChatUI

  Auth --> Postgres
  ConvAPI --> Postgres
  ChatAPI --> Postgres
  FileAPI --> ObjectStore
  FileAPI --> Vector
  KnowledgeTool --> Vector
  Policy --> Redis

  Runtime --> Jobs
  Jobs --> Runtime
  Runtime --> Observability
  Observability --> Alerts
  Evals --> Runtime
```

## Runtime Flow

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant UI as Web UI
  participant API as /api/chat/runs
  participant AG as Custom Agent Loop
  participant DS as DeepSeek Chat Completions
  participant DB as Postgres
  participant TO as App Tools/RAG/MCP
  participant OBS as Langfuse/OpenTelemetry

  U->>UI: Send prompt with optional files/project
  UI->>API: POST run request
  API->>DB: Create conversation/message/run
  API->>AG: Start agent run with user/session policy
  AG->>DB: Load history, summaries, project prompts, tool policy
  AG->>OBS: Create trace/span
  AG->>DS: Stream /chat/completions with messages and tools
  DS-->>AG: content delta or tool_call delta
  alt model requests tool
    AG->>TO: Execute allowed tool after policy checks
    TO-->>AG: Tool result + citations/artifacts
    AG->>DB: Persist tool call and tool message
    AG->>DS: Continue /chat/completions with appended tool message
  end
  AG->>DB: Persist assistant deltas and final status
  AG-->>API: Normalized UI stream events
  API-->>UI: SSE message.delta/tool/citation/usage/completed
  UI-->>U: Render streaming answer
  AG->>OBS: Record latency/tokens/cache/cost/errors
```

## Module Boundaries

| Module | Responsibility | Recommended Implementation |
| --- | --- | --- |
| App Shell | ChatGPT-like layout, navigation, responsive shell | Next.js, React, Tailwind, Radix/shadcn, lucide-react |
| Chat Runtime UI | Streaming messages, tool states, citations, retry/stop | Custom components plus assistant-ui or Vercel AI SDK patterns |
| BFF/API | Auth, tenant checks, SSE, key protection, request shaping | Next.js Route Handlers; extract later if needed |
| Agent Runtime | State building, model routing, tool loop, max-iteration control | Custom TypeScript Agent Loop |
| Model Layer | DeepSeek model calls, streaming chunks, thinking mode, JSON output | DeepSeek `/chat/completions`; `@ai-sdk/deepseek` or `openai` client with DeepSeek base URL |
| Tool Layer | Function tools, MCP gateway, approvals, audit | Typed tool registry + zod/json schema + policy engine |
| Knowledge Layer | File parsing, chunking, embedding, retrieval, citations | Supabase pgvector first; Qdrant/Weaviate/Milvus later |
| Web Search Layer | Fresh web lookup with citations | Tavily/Exa/Brave Search/SerpAPI or self-hosted crawler/search |
| Persistence | Conversations, messages, runs, tool calls, audit | Postgres |
| Async Jobs | Long reports, indexing, retries, notifications | Inngest/Trigger.dev for MVP; Temporal for complex scale |
| Observability | Trace, token/cost, cache hit, errors, feedback | Langfuse + OpenTelemetry |
| Evaluation | Regression, red team, RAG eval | Promptfoo in CI |

## Deployment View

```mermaid
flowchart TB
  subgraph Edge["Vercel or Cloudflare Edge"]
    CDN["Static Assets / CDN"]
  end

  subgraph App["Application Runtime"]
    Next["Next.js Web + API"]
    Worker["Agent Worker<br/>optional after MVP"]
  end

  subgraph Managed["Managed Services"]
    DB["Postgres<br/>Supabase or Neon"]
    Store["Object Storage<br/>Supabase Storage / S3 / R2 / Vercel Blob"]
    Vector["Vector Store<br/>Supabase pgvector"]
    Queue["Durable Jobs<br/>Inngest / Trigger.dev / Temporal"]
    Obs["Langfuse / OTel Collector"]
  end

  subgraph External["External AI & Tools"]
    DeepSeekAPI["DeepSeek API<br/>https://api.deepseek.com"]
    MCPServers["Remote MCP Servers"]
    SearchAPIs["Search APIs"]
    BusinessAPIs["Internal / Third-party APIs"]
  end

  CDN --> Next
  Next --> DB
  Next --> Store
  Next --> Vector
  Next --> Queue
  Next --> DeepSeekAPI
  Next --> Obs
  Queue --> Worker
  Worker --> DeepSeekAPI
  Worker --> MCPServers
  Worker --> SearchAPIs
  Worker --> BusinessAPIs
  Worker --> DB
  Worker --> Vector
  Worker --> Obs
```

## Key Design Decisions

- Keep the browser untrusted: no DeepSeek key, tool credentials, or raw system prompts in frontend code.
- Keep the database as the product source of truth: DeepSeek Chat Completions is stateless, so the app owns conversations, summaries, runs, and tool history.
- Normalize streaming events: frontend should consume `message.delta`, `tool.*`, `citation.*`, `usage.*`, and `run.*`, not raw provider chunks.
- Execute tools only in the application layer: DeepSeek chooses tool calls, but the backend validates policy, executes tools, records audit logs, and appends tool messages.
- Use current model names: prefer `deepseek-v4-flash` and `deepseek-v4-pro`; avoid new work depending on deprecated `deepseek-chat` / `deepseek-reasoner` aliases.
- Design for context caching: keep stable prompts and project context ordered consistently so DeepSeek prefix caching can help latency and cost.
- Treat tool outputs as untrusted: web pages, files, and external APIs can carry prompt injection.
- Start as a modular monolith: Next.js BFF + Agent module is enough for MVP; extract worker service when long tasks and queue pressure appear.
- Version prompts and tools: Agent behavior is product logic, so changes need review, evals, rollback, and traceability.
