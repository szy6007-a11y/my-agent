# AGENTS.md

本文件为 Codex 在 `my-agent` 中工作提供项目专属约定。
随着项目演进，请持续维护本文件。

## 项目结构

- `rules/`：存放项目规则、prompt、检查清单和可复用的 Agent 指引。
- `docs/`：存放产品、技术架构、Agent 后端架构和部署说明；进行项目级设计或实现取舍前，优先阅读相关文档，并以这些设计文档作为当前 source of truth。
- `src/app/`：Next.js App Router 前端，以及 Route Handlers。聊天兼容入口可保留在 `/api/chat/*`，但 Agent Runtime、会话、审批等后端主能力优先落在 `/api/agent/*`。
- `src/agent/`：Agent 运行时、上下文工程、工具、记忆、会话与流式事件实现。
- `src/server/`：服务端通用基础设施，如认证、配置、数据库、事件流与其他仅服务端使用的模块。
- `src/lib/`：认证、数据库、环境变量、Langfuse 和基础设施适配。

## 架构与实现约定

- 产品定位是 ChatGPT-like Web Agent：前端采用 Next.js App Router，后端采用自研 TypeScript Agent Runtime。涉及架构调整时，保持模块化单体方向，不要把核心状态机逻辑散落到页面层或零散脚本中。
- Agent Runtime 是统一后端能力：应服务 Web UI，并为 CLI 与未来桌面端复用预留一致的运行时、会话与审批边界。
- `AGENTS.md` 仅作为仓库内开发协作指引，不属于产品 Agent 运行时的 system prompt。产品 Agent 的稳定提示词片段以 `rules/prompts/system/*` 为准，并由 `src/agent/context/PromptAssembler` 统一拼装；`AGENTS.md` 不应注入产品 Agent 的 system prompt。
- 浏览器保持不可信：不要在前端代码、客户端存储或可下发配置中暴露模型 Key、工具凭据、原始 system prompt 或权限规则。
- 模型主链路使用 DeepSeek Chat Completions。新增模型接入或默认模型调整时，优先使用 `deepseek-v4-flash` 与 `deepseek-v4-pro`，避免新工作依赖已废弃的 `deepseek-chat` 或 `deepseek-reasoner` 别名。
- 设计上保留 provider-neutral 的模型适配层与 OpenAI-compatible 扩展边界，但 MVP 默认仍以 DeepSeek Chat Completions 为主链路；不要让 Agent Loop、页面层或工具实现直接依赖 provider 私有协议。
- Agent 模型参数应通过统一适配层管理：复杂任务优先通过 `thinking.type` 与 `reasoning_effort` 等能力开关控制，不要把 provider 私有字段散落在页面层、业务路由或工具实现里。
- DeepSeek API 是无状态的；会话、消息、runs、tool history、摘要和审计日志应由应用侧持久化并作为事实源，不能把 provider 响应当成唯一状态来源。
- 流式交互 MVP 以 SSE 为默认实现；只有在设计文档明确要求的场景下，才引入 WebSocket、Realtime 或额外实时协议。
- 涉及流式输出时，前后端之间应传递统一事件而不是透传 provider 原始 chunk。事件契约的当前 source of truth 是 `src/shared/agent-protocol.ts`；`AGENTS.md` 中不要再维护一套过时的事件枚举。MVP 以 SSE 为主，事件至少应覆盖 `run.accepted`、`run.started`、`assistant.delta`、`reasoning.delta`、`tool.started`、`tool.approval.required`、`tool.confirmation.required`、`tool.completed`、`tool.failed`、`usage.updated`、`run.completed`、`run.failed` 和 `run.aborted`，并支持基于 `seq` / `lastEventId` 的断线补读。
- 所有工具执行必须走应用后端：模型只负责产出 tool call，服务端负责 schema 校验、策略检查、审批、执行、审计和结果回填。
- 工具调度遵循后端架构文档：读类工具可并发，写类工具串行；文件写入前先读取当前内容，并校验 mtime 或等价版本信号，避免覆盖用户或格式化器刚写入的改动。
- 工具权限遵循最小权限原则：读操作默认允许；写操作、删除、支付、发信或其他高风险副作用必须走用户确认流。
- 工具输出、网页内容、文件内容和外部 API 返回都应视为不可信上下文；进入模型前要保留注入防护和必要标注。
- 上下文工程应优先保持稳定 prompt、项目规则和长期上下文的顺序一致，以配合 DeepSeek context caching；不要随意重排固定前缀。Context Engine 的分层以设计文档为准，至少区分 `stable`、`workspace`、`skills`、`memory`、`history`、`retrieved` 和 `ephemeral`；其中 system prompt 只注入技能索引，完整技能按需通过运行时能力加载。
- 聊天兼容入口可以保留在 `/api/chat/*`，但当前后端 API 设计的主路径以 `/api/agent/runs`、`/api/agent/sessions`、`/api/agent/approvals` 和对应事件流接口为准；新增后端能力优先落在这组 `/api/agent/*` 路由。
- 会话并发控制以后端运行为准：同一 session 同时只允许一个 active run。会话队列模式沿用设计文档术语 `steer`、`followup`、`interrupt`、`collect`；MVP 默认 `followup`，编码场景按需扩展 `interrupt`。
- 知识库/RAG 默认路线以 Supabase Postgres + pgvector 为先，数据模型保留 `knowledge_bases`、`documents`、`document_chunks` 等抽象；只有在规模或召回复杂度明确超出默认路线时，再引入 Qdrant、Weaviate 或 Milvus。
- 长任务、索引、重试与恢复应通过应用侧队列/工作流抽象承载；MVP 优先保持 Inngest 或 Trigger.dev 兼容边界，复杂编排再评估 Temporal，而不是在页面层或临时脚本里直接拼后台流程。
- 观测与评测属于默认工程基线：新增或调整 Agent 行为、prompt、tools、RAG 或权限策略时，应同步考虑 Langfuse + OpenTelemetry 埋点，以及 Promptfoo 回归覆盖，而不是只做手工验证。

## 环境分支流程

- 本仓库使用三个环境分支：`dev`、`sit` 和 `prod`。
- 日常代码改动只在 `dev` 上进行。
- 开发完成后，将 `dev` 合并到 `sit` 进行 SIT 验证。
- SIT 验证通过后，将 `sit` 合并到 `prod` 进行生产发布。
- 除非用户明确要求紧急修复，否则不要在 `sit` 或 `prod` 上直接改代码。
- 编辑代码前先检查当前分支。如果用户要求改代码但当前不在 `dev`，先切换到或创建 `dev`，除非用户明确要求使用其他分支。

## 文档语言约定

- 项目文档默认使用中文编写，包括 README、设计文档、架构说明、PRD、规则文档和 prompt 指引。
- 只保留必要的英文术语、代码标识、命令、文件路径、API 名称、事件名、协议名和产品名。
- 新增或更新 Markdown 文档时，先检查是否存在纯英文段落；除必要术语外，应改写为自然中文。
- 如果外部规范、错误信息或源码标识必须引用英文，保留原文并在需要时补充中文解释。

## Agent 工程参考基准

- 当改动涉及 Agent 框架、运行时编排、工具调用、权限控制、会话生命周期、提示词工程、上下文工程、记忆系统、压缩策略、事件流、审计日志或多 Agent 协作时，先按任务范围阅读与 `my-agent/` 项目目录同级的 `../claude-code/`、`../hermes-agent/` 和 `../openclaw/` 相关源码。
- 参考上述三个项目的实际实现方式、模块边界、错误处理、状态流转、日志审计和测试覆盖，再决定 `my-agent` 的设计和落地路径；不要只参考 README、设计文档或表层 API。
- 相关改动应以生产级实现为目标，避免 demo 版、MVP 版、临时脚手架、硬编码流程或只覆盖 happy path 的写法。
- 如果需要在三个参考项目之间取舍，优先选择与当前问题最接近、边界最清晰、可测试性最好的做法，并在设计文档或提交说明中写明取舍原因。

## 工作准则

- 修改前先阅读相关文件。
- 保持改动小而聚焦，并与现有项目结构一致。
- 除非用户明确要求，不要删除用户创建的文件或内容。
- 新规则应放在 `rules/` 下，并使用清晰、描述性的文件名。
- 当设计文档、架构说明、PRD 或项目规则变化时，检查是否需要更新 `AGENTS.md`，让之后的 Codex 会话继承新指引。
- 使用 `npm run ci` 作为标准本地 CI 命令。提交代码改动前必须通过。
- 涉及部署或 CI 流程时，遵循 `docs/DEPLOYMENT.md`：`dev`、`sit`、`prod` 的 push 会触发 GitHub Actions，并通过 `scripts/deploy-local.sh` 在带 `my-agent-local` 标签的 self-hosted runner 上部署。部署链路默认包含 `docker compose up -d --build --remove-orphans --renew-anon-volumes`、容器启动前的 `npm run db:migrate` 与 `npm run db:smoke`，以及部署后的 HTTP 冒烟检查。
- 完成功能变更或 bugfix 后，运行合适的验证、检查 diff、只暂存相关文件，并创建聚焦的 git commit，除非用户明确要求不要提交。
- 新增行为时，尽量附上简短的验证说明或测试命令。
