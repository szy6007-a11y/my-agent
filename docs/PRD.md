# ChatGPT-like Web Agent 产品需求文档（PRD）

调研日期：2026-06-17  
目标版本：MVP v0.1  
产品定位：一个前端交互尽量接近 ChatGPT、后端由服务端封装 DeepSeek API Key 和 Agent 工具能力的网页端 Agent 应用。

## 1. 背景与结论

用户需要的不是单轮聊天机器人，而是一个“ChatGPT-like Agent 工作台”：左侧会话与项目导航，中央对话区，底部多模态输入框，后端支持流式输出、工具调用、文件检索、联网搜索、可观测与安全审计。

调研后的建议方案：

- 前端自研 ChatGPT-like 外壳，避免直接使用 ChatGPT 品牌、Logo、文案和受保护视觉资产；交互结构可参考截图中的侧栏、会话列表、中央空态和底部 Composer。
- 后端使用 DeepSeek Chat Completions API 作为 LLM 调用主线；不使用 OpenAI Responses 协议。服务端持有 `DEEPSEEK_API_KEY`，浏览器只访问自己的 `/api/*`。
- 流式交互使用 SSE 或 WebSocket。MVP 用 SSE，后续语音/实时协作再引入 Realtime/WebRTC。
- DeepSeek `/chat/completions` 是无状态 API，因此会话历史、上下文压缩、RAG 检索、联网搜索、工具执行都由应用后端管理。
- 知识库 MVP 使用 Supabase/Postgres + pgvector 或 Qdrant/Weaviate 一类自建向量检索，不依赖 OpenAI File Search。
- 长任务使用应用侧 durable workflow，优先 Inngest/Trigger.dev/Temporal 之一；MVP 可先落队列抽象。
- 生产实践必须补齐安全、观测、评测：OWASP LLM Top 10、应用侧 guardrails/human review、Langfuse/OpenTelemetry、Promptfoo 回归评测。

## 2. 参考与验证来源

DeepSeek 官方：

- DeepSeek API Quick Start：<https://api-docs.deepseek.com/>
- Chat Completions API：<https://api-docs.deepseek.com/api/create-chat-completion>
- Tool Calls / Function Calling：<https://api-docs.deepseek.com/guides/function_calling>
- Multi-round Conversation：<https://api-docs.deepseek.com/guides/multi_round_chat>
- JSON Output：<https://api-docs.deepseek.com/guides/json_mode>
- Context Caching：<https://api-docs.deepseek.com/guides/kv_cache>
- Models & Pricing：<https://api-docs.deepseek.com/quick_start/pricing>
- Rate Limit & Isolation：<https://api-docs.deepseek.com/quick_start/rate_limit>

开源与工程实践：

- Vercel AI SDK：<https://ai-sdk.dev/docs/introduction>
- Vercel AI SDK DeepSeek Provider：<https://ai-sdk.dev/providers/ai-sdk-providers/deepseek>
- Vercel AI SDK OpenAI-compatible Providers：<https://ai-sdk.dev/providers/openai-compatible-providers>
- Vercel Chatbot template：<https://github.com/vercel/chatbot>
- Next.js App Router/Route Handlers：<https://nextjs.org/docs/app/getting-started/route-handlers>
- assistant-ui：<https://www.assistant-ui.com/docs>
- AG-UI protocol：<https://docs.ag-ui.com/introduction>
- Open WebUI：<https://docs.openwebui.com/features/>
- LibreChat：<https://www.librechat.ai/>
- Supabase Postgres/Auth/Storage/Vector：<https://supabase.com/docs>
- Neon Postgres：<https://neon.com/docs/introduction>
- Tavily Search API：<https://docs.tavily.com/welcome>
- Exa Search API：<https://exa.ai/docs/reference/search>
- Brave Search API：<https://brave.com/search/api/>
- SerpAPI：<https://serpapi.com/search-api>
- Auth.js：<https://authjs.dev/>
- Inngest：<https://www.inngest.com/docs>
- Trigger.dev：<https://trigger.dev/>
- Temporal TypeScript SDK：<https://docs.temporal.io/develop/typescript>
- LangGraph：<https://docs.langchain.com/oss/python/langgraph/overview>
- Mastra：<https://mastra.ai/>
- Langfuse：<https://langfuse.com/docs>
- Promptfoo：<https://www.promptfoo.dev/docs/intro/>
- OWASP LLM Top 10：<https://owasp.org/www-project-top-10-for-large-language-model-applications/>

## 3. 产品目标

### 3.1 用户目标

- 像使用 ChatGPT 一样快速发起、查找、继续会话。
- 在同一界面中使用通用聊天、联网搜索、文件问答、项目知识库、工具执行。
- 会话可保存、搜索、置顶、归档，并能跨设备继续。
- 对 Agent 的工具调用过程有足够可见性，例如“正在搜索”“正在读取文件”“等待确认”。

### 3.2 业务目标

- 构建可扩展 Agent 平台底座，而不是一次性聊天 Demo。
- API Key、模型路由、工具权限、成本控制全部在服务端托管。
- 支持后续从单 Agent 演进到多 Agent、项目空间、插件/MCP、团队协作。

### 3.3 非目标

- 不复制 ChatGPT 商标、Logo、专有图标、专有文案或未经授权素材。
- MVP 不做复杂组织权限、插件市场、完整移动端 App、浏览器自动操作。
- MVP 不承诺 OpenAI 官方 hosted tools、Responses state、ChatKit 或 Agents SDK 能力；联网搜索、RAG、代码执行等由应用侧工具实现。
- MVP 不承诺离线本地模型；可以预留 OpenAI-compatible provider 适配层。

## 4. 目标用户与场景

### 4.1 目标用户

- 个人高频 AI 用户：希望有自己的 API Key 封装、成本可控、数据可控。
- 知识工作者：需要搜索、文件问答、项目资料沉淀。
- 开发者/运营/研究人员：需要工具调用、引用来源、任务记录和可复查过程。

### 4.2 核心场景

- 普通聊天：写作、解释、总结、翻译、头脑风暴。
- 联网问答：模型按需调用 web search，返回来源引用。
- 文件问答：上传 PDF、文档、表格后进行 RAG 问答。
- 项目空间：把会话、文件、提示词和默认 Agent 绑定到一个项目。
- 工具执行：调用内部 API、搜索、代码执行、工作流等工具。
- 长任务：调研报告、批量处理、深度检索，任务可后台运行并恢复。

## 5. MVP 范围

### 5.1 P0 功能

- 登录/登出：邮箱或 OAuth，服务端会话。
- ChatGPT-like 主界面：
  - 左侧侧栏：新聊天、搜索聊天、库、项目、应用、更多、置顶、最近、用户菜单。
  - 主对话区：空态标题、消息流、Markdown 渲染、代码块、引用、工具状态。
  - 底部 Composer：附件按钮、输入框、模型/模式选择、语音入口占位、发送/停止按钮。
- 会话管理：创建、重命名、删除、置顶、搜索、分页加载。
- Agent 后端：
  - DeepSeek API Key 仅存在服务端环境变量或密钥管理系统。
  - 基于 DeepSeek `/chat/completions` 发起模型调用。
  - 应用侧维护 conversation/messages，并在每次请求中拼接必要上下文。
  - 自研 Agent Loop：模型产出 tool call 后，由后端执行工具、追加 tool message，再继续调用模型，直到得到最终答复或达到最大迭代次数。
  - 支持流式输出、停止生成、错误重试。
  - 支持基础 function tools。
- 文件上传与 RAG：
  - 上传文件到对象存储。
  - 为会话或项目创建知识库索引。
  - Agent 通过应用侧 `search_knowledge` 工具检索 pgvector/Qdrant/Weaviate，并返回来源。
- 联网搜索：
  - 用户可选择“自动/开启/关闭联网搜索”。
  - Agent 通过应用侧 `web_search` 工具调用 Tavily、Exa、Brave Search、SerpAPI 或自建搜索服务。
  - 联网回答展示来源。
- 基础安全与风控：
  - 用户级限流、消息长度限制、文件大小限制。
  - 输入/输出安全检查。
  - 工具调用 allowlist。
  - 所有工具调用写审计日志。
- 观测：
  - 记录请求耗时、token/cost、模型、工具调用、错误。
  - 接入 Langfuse 或 OpenTelemetry 之一。

### 5.2 P1 功能

- 项目空间：项目内默认模型、默认工具、项目文件库、项目提示词。
- Agent 模板：通用助手、研究助手、文档助手、代码助手。
- Human-in-the-loop：高风险工具调用前需要用户确认。
- 长任务：后台运行、任务列表、完成通知。
- 语音输入：浏览器录音 + speech-to-text。
- 多模型路由：高质量模型、快速模型、低成本模型由服务端策略选择。
- Prompt 版本管理与 A/B 测试。

### 5.3 P2 功能

- MCP 工具接入与工具市场。
- 共享会话与团队空间。
- Artifacts：生成文档、表格、代码、图表的右侧工作区。
- Realtime 语音对话。
- 多租户计费、额度、团队管理。

## 6. 界面与交互拆解

### 6.1 布局

参考用户截图的信息架构：

- 左侧固定侧栏，桌面端宽度约 236px，可折叠。
- 顶部品牌区：应用名、折叠按钮。
- 一级入口：新聊天、搜索聊天、库、项目、应用、更多。
- 会话分组：置顶、最近，支持滚动。
- 底部账号区：头像、用户名、套餐/额度状态、设置入口。
- 主区域：极简空白画布，未开始会话时居中显示一句引导语。
- Composer：底部居中，最大宽度约 720px，圆角胶囊输入框，左侧附件，右侧模型/模式、语音、发送。

### 6.2 关键状态

- 空态：显示“今天想做什么？”或自有品牌文案。
- 生成中：发送按钮切换为停止按钮；消息气泡流式增长；工具状态 inline 展示。
- 工具调用中：展示工具名称、状态、耗时；敏感工具进入待确认卡片。
- 附件上传中：展示文件 chip、进度、失败重试。
- 错误：保留用户输入，提示重试，不丢失上下文。
- 离线/网络抖动：中断提示，支持继续生成。

### 6.3 视觉原则

- 整体白底/浅灰侧栏，低对比边框，少装饰，信息密度接近 ChatGPT。
- 按钮使用 lucide-react 图标；不使用冗长文字按钮替代熟悉图标。
- 卡片只用于消息、工具调用、确认弹窗、文件条目；页面区块不做大面积卡片堆叠。
- 移动端侧栏变抽屉，Composer 固定底部，消息区留出安全区域。

## 7. 后端 Agent 能力拆解

### 7.1 Agent Runtime（运行时）

- Agent 定义：名称、说明、system/developer 指令、默认模型、可用工具、输出格式。
- 模型调用：DeepSeek `/chat/completions`。官方文档在 2026-06-17 显示当前模型为 `deepseek-v4-flash` 与 `deepseek-v4-pro`；`deepseek-chat` 与 `deepseek-reasoner` 将在 2026-07-24 15:59 UTC 废弃。MVP 默认 `deepseek-v4-flash`，复杂任务/高质量模式使用 `deepseek-v4-pro`。
- 思考模式：通过 `thinking.type` 在 `enabled` / `disabled` 间切换；复杂 Agent 任务可使用 `reasoning_effort: "max"`，常规任务使用 `"high"`。
- 状态管理：
  - 应用数据库保存 canonical conversation/messages。
  - DeepSeek Chat Completions 是无状态 API；服务端必须在每次请求中拼接历史、摘要、项目提示词、RAG 片段和工具结果。
  - 利用 DeepSeek Context Caching 的前缀缓存特性，尽量保持 system prompt、项目规则、稳定上下文的顺序和文本一致，提升缓存命中和成本表现。
- 流式事件：
  - DeepSeek `stream: true` 返回 data-only SSE，后端把 content delta、tool call delta、usage chunk 转成前端统一事件：`message.delta`、`tool.started`、`tool.completed`、`citation.added`、`usage.updated`、`run.completed`、`run.error`。
- 停止生成：前端发 abort，服务端取消上游请求并写入中断状态。

### 7.2 工具层

- DeepSeek Function Tools：通过 Chat Completions `tools` 参数暴露工具 schema；模型只返回 tool call，具体执行由应用后端完成。
- 应用侧工具：业务 API、数据库查询、CRM、联网搜索、RAG 检索、计算、格式转换、代码沙箱等。
- MCP tools：后续通过应用侧 MCP gateway 接入 Google Drive、GitHub、Notion、Slack 等外部工具，再包装成 DeepSeek function tools。
- Tool 策略：
  - 工具必须有 schema、描述、权限级别、超时、重试、审计。
  - 读操作默认允许；写操作、支付、发邮件、删除数据等必须用户确认。
  - 工具输出视为不可信上下文，进入模型前做内容标注和注入防护。

### 7.3 RAG/知识库

MVP 推荐两种路径：

- 默认路径：Supabase Postgres + pgvector + 自建 embedding/检索 API。优点是数据、召回、权限、审计可控，并且不依赖 OpenAI Key；缺点是需要自己做解析、chunk、embedding、召回和评测。
- 扩展路径：Qdrant/Weaviate/Milvus。适合知识库规模变大、召回策略复杂、需要独立向量服务时使用。

MVP 默认选择 Supabase pgvector；数据模型保留 `knowledge_bases`、`documents`、`document_chunks` 抽象，方便未来替换向量数据库或 embedding provider。

### 7.4 安全与治理

- API Key 不下发浏览器；使用服务端密钥管理。
- 所有请求绑定用户、组织、会话和 trace id。
- 基于 OWASP LLM Top 10 做威胁模型：Prompt Injection、Sensitive Information Disclosure、Excessive Agency、Vector/Embedding Weaknesses、Unbounded Consumption。
- 输入安全：长度、文件类型、内容安全、恶意 prompt 模式检测。
- 输出安全：敏感信息、违规内容、工具结果泄露检查。
- 工具安全：最小权限、显式 allowlist、超时、沙箱、确认流、审计日志。
- 数据安全：RLS/租户隔离、加密存储、日志脱敏、数据保留策略。

## 8. 技术选型

### 8.1 推荐默认栈

| 层 | 推荐 | 原因 |
| --- | --- | --- |
| Web 框架 | Next.js App Router + TypeScript | 现代 React 全栈主流，Route Handlers 适合封装 LLM Key 与 SSE |
| UI | Tailwind CSS + shadcn/ui/Radix + lucide-react | 开源、可定制、容易还原 ChatGPT-like 极简工作台 |
| Chat UI 加速 | assistant-ui 或 Vercel AI SDK UI hooks | 支持流式、多轮、重试、中断；适合作为自研 UI 的基础 |
| Agent Runtime | 自研 TypeScript Agent Loop；复杂场景可引入 LangGraph 或 Mastra | DeepSeek 提供模型与 tool call，但不提供 Responses state/hosted tools；应用侧需要掌控循环、权限和状态 |
| LLM API | DeepSeek Chat Completions API | DeepSeek 官方 OpenAI-compatible/Anthropic-compatible API；支持 streaming、tool calls、JSON output、thinking mode |
| SDK | `@ai-sdk/deepseek` 或 `openai` npm client + `baseURL=https://api.deepseek.com` | 前者适合 AI SDK 生态，后者便于完整控制 DeepSeek 特有参数 |
| 数据库 | Postgres | 会话、消息、项目、审计、配置的事实源 |
| 托管组合 | Supabase 或 Neon + Auth.js + S3-compatible storage | Supabase 集成 Auth/Storage/Vector；Neon/Auth.js/Vercel Blob 更贴近 Vercel Chatbot 模板 |
| 文件/对象存储 | Supabase Storage、S3、Cloudflare R2 或 Vercel Blob | 文件上传、附件、导出、artifact |
| 搜索/RAG | Supabase pgvector；可扩展 Qdrant/Weaviate/Milvus | 不依赖 OpenAI Key，权限和召回策略可控 |
| 联网搜索 | 应用侧 search tool：Tavily/Exa/Brave Search/SerpAPI/自建 | DeepSeek 本身不提供 hosted web_search，需要工具层补齐 |
| 后台任务 | Inngest/Trigger.dev；规模化可选 Temporal | 长任务、重试、恢复、限流、观测 |
| 观测 | Langfuse + OpenTelemetry | LLM trace、prompt、cost、latency 与通用分布式观测 |
| 评测 | Promptfoo + 自建 goldens | 回归评测、红队、安全扫描、CI |
| 部署 | Vercel + Supabase/Neon；或 Docker/K8s | MVP 快速；企业版再容器化 |

### 8.2 候选方案对比

| 方案 | 适合 | 不适合 |
| --- | --- | --- |
| DeepSeek Chat Completions + 自研 Agent Loop | DeepSeek-first、需要完全控制会话、RAG、搜索、工具权限 | 多 Agent 图编排、人审恢复、复杂长期任务需要额外框架 |
| Vercel AI SDK + `@ai-sdk/deepseek` | TypeScript 全栈、流式 UI、快速上线 | DeepSeek 特有参数或复杂 tool loop 可能需要下探到原始 SDK |
| `openai` npm client + DeepSeek `baseURL` | 希望直接调用 DeepSeek 官方兼容接口，完整控制参数 | 需要自己封装流式事件和工具循环 |
| LangGraph | 复杂状态机、durable execution、人审、长期多步任务 | MVP 简单聊天，可能过重 |
| Mastra | TypeScript-first、一体化 agents/workflows/memory/evals | 团队只想维护极简自研 Agent Loop 时可能偏重 |
| Open WebUI/LibreChat 二开 | 快速获得完整开源 AI 平台 | 深度产品差异化、代码复杂度和架构约束较大 |

推荐：MVP 不二开 Open WebUI/LibreChat，而是借鉴模块边界和功能清单；代码从 Next.js + DeepSeek Chat Completions + 自研 TypeScript Agent Loop 开始，必要时借用 Vercel Chatbot/assistant-ui 模式。

## 9. 数据模型草案

核心表：

- `users`：用户资料、状态、默认配置。
- `organizations`：组织/团队，MVP 可先单用户。
- `memberships`：用户与组织关系。
- `projects`：项目空间、默认 Agent、默认知识库。
- `agents`：Agent 模板、instructions、model config、tool policy。
- `conversations`：会话元信息、标题、归档、置顶、所属项目。
- `messages`：用户/助手/系统/工具消息，保存 canonical 内容。
- `runs`：一次 Agent 执行，模型、状态、耗时、token、cost、trace id。
- `tool_calls`：工具调用入参、输出摘要、状态、审批状态。
- `files`：原始文件、存储地址、大小、hash、解析状态。
- `knowledge_bases`：知识库配置、provider、索引状态。
- `documents`：知识库文档、版本、权限。
- `document_chunks`：chunk 文本、embedding、metadata、向量索引状态。
- `citations`：回答引用的文档、URL、chunk、位置。
- `audit_logs`：登录、配置变更、工具调用、敏感操作。

## 10. API 草案

### 10.1 聊天

- `POST /api/chat/runs`
  - 输入：`conversationId?`、`projectId?`、`messages`、`attachments`、`modelMode`、`toolsMode`
  - 输出：SSE stream
  - 事件：`run.created`、`message.delta`、`tool.started`、`tool.delta`、`tool.completed`、`citation.added`、`usage.updated`、`run.completed`、`run.error`

- `POST /api/chat/runs/:runId/cancel`
  - 取消生成。

- `POST /api/messages/:messageId/retry`
  - 从指定消息重新生成。

### 10.2 会话

- `GET /api/conversations`
- `POST /api/conversations`
- `PATCH /api/conversations/:id`
- `DELETE /api/conversations/:id`
- `GET /api/conversations/search?q=...`

### 10.3 文件与知识库

- `POST /api/files/presign`
- `POST /api/files/complete`
- `POST /api/knowledge-bases`
- `POST /api/knowledge-bases/:id/documents`
- `GET /api/knowledge-bases/:id/documents`

### 10.4 Tools 与 Agents

- `GET /api/agents`
- `POST /api/agents`
- `GET /api/tools`
- `PATCH /api/tools/:id/policy`
- `POST /api/tool-approvals/:id/approve`
- `POST /api/tool-approvals/:id/reject`

## 11. 验收标准

### 11.1 UX 验收

- 桌面端首屏与截图的信息结构一致：左侧导航、会话列表、中央空态、底部 Composer。
- 发送消息后 500ms 内出现生成状态或首个流式事件。
- 生成中可停止；停止后 UI 状态稳定且不丢消息。
- 会话搜索、置顶、删除、重命名不刷新页面。
- Markdown、代码块、表格、引用链接可读。

### 11.2 Agent 验收

- DeepSeek API Key 不出现在前端 bundle、网络响应或日志中。
- 普通聊天、联网搜索、文件问答各有一条端到端测试。
- 工具调用有状态展示、超时、错误处理、审计日志。
- 长文本或文件问答不会阻塞整个应用。

### 11.3 安全验收

- Prompt injection、越权文件访问、超长输入、危险工具调用有测试用例。
- 写操作工具必须二次确认。
- 用户只能访问自己的会话、文件、项目。
- 生产日志不记录完整 API Key、OAuth token、原始敏感文件内容。

### 11.4 观测与评测验收

- 每次 run 有 trace id、模型、耗时、token/cost、工具调用记录。
- Promptfoo 至少覆盖 20 条核心回归样例。
- 失败率、平均延迟、P95 延迟、token 成本可查询。

## 12. 里程碑

### Sprint 0：基础架构

- 初始化 Next.js/TypeScript 项目。
- 接入 Auth、Postgres、基础 UI Shell。
- 建立 lint/test/format/CI。

### Sprint 1：聊天 MVP

- 会话 CRUD。
- Composer 与消息流。
- 服务端 DeepSeek Chat Completions 调用。
- 应用侧多轮上下文拼接、Agent Loop、工具调用回合。
- SSE streaming、停止、重试。

### Sprint 2：Agent 工具与 RAG

- web search（联网搜索）。
- 文件上传、解析、embedding、pgvector 检索。
- 工具状态 UI。
- 基础工具审计。

### Sprint 3：项目空间与安全

- 项目、知识库、Agent 模板。
- guardrails、人审确认。
- 观测、Promptfoo 回归、安全测试。

### Sprint 4：生产化

- 限流、成本控制、后台任务。
- 部署、监控、错误告警。
- Beta 用户反馈迭代。

## 13. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 过度复制 ChatGPT 视觉 | 商标/品牌风险 | 只参考交互布局，自有品牌和视觉资产 |
| Agent 工具误操作 | 数据安全风险 | allowlist、最小权限、人审、审计 |
| Prompt injection | 工具越权/数据泄露 | OWASP 威胁建模、工具输出标注、权限隔离、红队测试 |
| 流式链路不稳定 | 用户体验差 | SSE 重连、run 状态持久化、停止/重试 |
| 成本失控 | 运营不可控 | 限额、模型路由、token 预算、缓存、后台任务成本上限 |
| RAG 准确率不稳 | 用户信任下降 | 引用展示、召回评测、chunk 策略、人工反馈 |
| 早期架构过重 | 研发速度慢 | MVP 采用 Next.js 全栈单体，后续拆 agent worker |
