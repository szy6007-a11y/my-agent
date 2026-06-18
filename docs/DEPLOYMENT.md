# 部署说明

本项目代码托管在 GitHub：

```bash
git@github.com:szy6007-a11y/my-agent.git
```

## 分支和发布

- `dev`：日常开发分支，push 后自动部署到当前本机环境。
- `sit`：由 `dev` 合并而来，用于 SIT 验证。
- `prod`：由 `sit` 合并而来，用于生产发布。

workflow 会在 `dev`、`sit`、`prod` 的 push 上运行 CI。CI 通过后，部署 job 会在带有 `my-agent-local` 标签的 GitHub self-hosted runner 上执行：

```bash
scripts/deploy-local.sh
```

部署脚本会执行：

```bash
docker compose up -d --build --remove-orphans --renew-anon-volumes
```

`--renew-anon-volumes` 用来刷新 `/app/node_modules` 匿名卷，避免旧卷遮住新镜像中的依赖。`web` 容器启动命令会先运行 `npm run db:migrate` 与 `npm run db:smoke`，通过后才启动 Next.js。随后部署脚本访问 `http://127.0.0.1:${APP_PORT}/` 做 HTTP 冒烟检查。

部署 job 会使用与分支同名的 GitHub Environment：`dev`、`sit`、`prod`。如果后续需要分环境密钥，可以分别在这些 Environment 下配置同名 Secret。

## 本机 runner

GitHub 托管 runner 不能直接部署到本地主机，所以当前机器需要注册一个 self-hosted runner。

在 GitHub 仓库页面进入：

```text
Settings -> Actions -> Runners -> New self-hosted runner
```

选择 macOS，按页面给出的命令下载并配置 runner。配置时给 runner 添加这个标签：

```text
my-agent-local
```

推荐将 runner 放在类似下面的目录：

```bash
mkdir -p /Users/shenzhengyang/actions-runner/my-agent
```

配置完成后，可以先直接运行：

```bash
./run.sh
```

确认 workflow 能部署后，再按 GitHub 页面提示安装为后台服务。

## 环境变量

`.env` 不提交到 Git。部署时脚本按以下顺序寻找环境配置：

1. 当前 runner 工作目录里的 `.env`
2. GitHub Secret `MY_AGENT_ENV_FILE`
3. GitHub Variable `MY_AGENT_ENV_SOURCE` 指向的本机文件路径
4. 当前本机默认路径 `/Users/shenzhengyang/workspace/my-agent/.env.${GITHUB_REF_NAME}`
5. 当前本机默认路径 `/Users/shenzhengyang/workspace/my-agent/.env`

当前本机已经有 `.env`，所以本机 runner 可以直接复用它。后续换机器部署时，建议在 GitHub Secrets 中创建 `MY_AGENT_ENV_FILE`，内容为目标环境的完整 `.env`。

## 手动部署

在本机调试部署流程时可以直接运行：

```bash
cd /Users/shenzhengyang/workspace/my-agent
scripts/deploy-local.sh
```
