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

## 原型流程

当前原型实现了 `docs/AGENT_BACKEND_ARCHITECTURE.md` 中的第一个后端里程碑：

- `POST /api/agent/runs` 创建 session/run，持久化用户消息，流式输出 DeepSeek 结果，保存 assistant 消息，并追加 run 事件。
- 前端消费标准化的 Agent 事件，例如 `run.accepted`、`context.built`、`assistant.delta`、`usage.updated` 和 `run.completed`。
- Tool 执行、审批流程和上下文压缩会留到后续里程碑实现。
