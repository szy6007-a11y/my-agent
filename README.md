# My Agent

由 DeepSeek 驱动的 ChatGPT-like 网页 Agent。

## 开发

```bash
docker compose up -d --build
```

`web` 容器启动时会先执行：

```bash
npm run db:migrate
npm run db:smoke
```

如果在宿主机直接运行 Next.js，请先确保 `.env` 里的 `DATABASE_URL` 指向可访问的 Postgres，然后手动执行同样的迁移和 smoke 校验。

打开：

- Web app：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>

配置保存在 `.env` 中。不要把密钥提交到源码仓库。

## CI/CD

代码远端托管在 `git@github.com:szy6007-a11y/my-agent.git`。push 到 `dev`、`sit` 或 `prod` 后，GitHub Actions 会先运行 CI；CI 通过后，由本机的 GitHub self-hosted runner 执行 Docker Compose 部署。

部署细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 原型流程

当前原型实现了 `docs/AGENT_BACKEND_ARCHITECTURE.md` 中的第一个后端里程碑：

- `POST /api/agent/runs` 创建 session/run，持久化用户消息，流式输出 DeepSeek 结果，保存 assistant 消息，并追加 run 事件。
- 前后端共用 `src/shared/agent-protocol.ts` 中的 Agent 事件类型，例如 `run.accepted`、`context.built`、`assistant.delta`、`tool.started`、`usage.updated` 和 `run.completed`。
- 已接入 Tool 执行、持久记忆、会话搜索、上下文压缩和 Web 工具。Web 搜索/提取支持 Firecrawl、Parallel、Tavily、Exa、SearXNG、Brave Search 和 DuckDuckGo 风格后端，配置见 `.env.example`。
- Agent Runtime 已接入持久化 `<system-reminder>`、用户控制标记净化、模型 payload 修复、hook 注册表、协议恢复、恢复性压缩、工具 span 和写类工具确认事件。
- 数据库结构已迁移到 `src/server/db/schema/` 的 Drizzle schema，变更通过 `drizzle/` SQL migration 落库，并用 `npm run db:smoke` 校验表、列、索引和 migration 记录。
- 审批 API 会留到后续里程碑实现；当前写类工具会先发出 `tool.approval.required` / `tool.confirmation.required` 并阻止直接执行。
