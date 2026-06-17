# My Agent

由 DeepSeek 驱动的 ChatGPT-like 网页 Agent。

## 开发

```bash
docker compose up -d --build
```

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
- 前端消费标准化的 Agent 事件，例如 `run.accepted`、`context.built`、`assistant.delta`、`usage.updated` 和 `run.completed`。
- 已接入 Tool 执行、持久记忆、会话搜索、上下文压缩和 Web 工具。Web 搜索/提取支持 Firecrawl、Parallel、Tavily、Exa、SearXNG、Brave Search 和 DuckDuckGo 风格后端，配置见 `.env.example`。
- 审批流程会留到后续里程碑实现。
