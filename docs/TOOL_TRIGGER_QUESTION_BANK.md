# Tool 触发单项测试题库

本文档用于测试当前默认 `ToolRegistry` 中已启用的 15 个模型可见工具是否能被正确触发。题库关注“模型是否选择了正确 tool call”，不是测试工具执行结果的业务正确性。

当前默认工具列表来自 `new ToolRegistry().names`：

- `memory`
- `session_search`
- `web_search`
- `read_file`
- `write_file_chunk`
- `write_file`
- `edit_file`
- `install_github_skill`
- `activate_skill_install`
- `Skill`
- `skills_list`
- `skill_view`
- `list_installed_skills`
- `skill_manage`
- `manage_skill`

`web_extract` 当前没有出现在默认启用列表里，因此不纳入本题库。若后续配置 extract provider 并启用该工具，应另加独立测试项。

## 判定规则

- 每道题建议在新 session 中测试，除非题目明确要求依赖前置状态。
- 通过标准：事件流或模型请求中出现期望的 `tool_call.name`，并且参数意图与题目匹配。
- 对写类工具，通过标准可以是触发审批请求；不要求审批后真实写入成功。
- “允许前置工具”只用于安全或状态准备。例如 `edit_file` 必须先完整读取文件，因此允许先触发 `read_file`，但目标工具仍必须是 `edit_file`。
- “禁止工具”用于防止模型用相近工具绕过题目，例如大文件题不应走 `write_file`。
- 如果测试目标是区分同义别名工具，例如 `Skill` 与 `skill_view`，题目允许直接点名工具名；否则无法只凭自然语言稳定区分两个等价读取入口。

## 建议测试夹具

测试环境可预置以下变量或文件：

- `$TEST_GITHUB_SKILL_SOURCE`：一个可安装的 Codex Skill GitHub source，例如 `owner/repo/path` 或完整 GitHub tree URL。
- `$TEST_PROPOSAL_ID`：`install_github_skill` 返回的安装提案 ID。
- `$TEST_SKILL_NAME`：一个已存在且可读取的测试 skill 名称，例如 `tool-trigger-fixture`。
- `$TEST_INSTALLED_SKILL_NAME`：一个已安装、可启用或禁用的测试 skill 名称。
- `fixtures/tool-trigger/readme.txt`：用于 `read_file` 的小文本文件。
- `fixtures/tool-trigger/edit-target.txt`：用于 `edit_file` 的文本文件，内容包含唯一字符串 `color = red`。

## 单项题库

| ID | 目标工具 | 用户题目 | 期望参数要点 | 允许前置工具 | 禁止工具 | 通过标准 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | `memory` | 请记住一个长期偏好：以后我的项目文档默认用中文写，只有代码标识符保留英文。 | `action=add`，`target=user` 或 `target=memory`，`content` 写成稳定事实 | 无 | `session_search`, `web_search` | 触发 `memory`，并进入写入审批流程 |
| T02 | `session_search` | 我们之前关于 `web_search` 无法触发的问题，最后判断的根因是什么？请从历史会话里查。 | `query` 包含 `web_search`、`无法触发`、`根因` 等关键词 | 无 | `web_search`, `memory` | 触发 `session_search`，而不是凭当前上下文或记忆回答 |
| T03 | `web_search` | 请查一下 Node.js 当前最新 LTS 版本是什么，并给出来源链接。 | `query` 指向 Node.js latest LTS/current LTS | 无 | `session_search`, `read_file` | 触发 `web_search`，最终回答带来源链接 |
| T04 | `read_file` | 读取工作区文件 `fixtures/tool-trigger/readme.txt` 的内容。 | `path=fixtures/tool-trigger/readme.txt` | 无 | `web_search`, `session_search` | 触发 `read_file`，不改写文件 |
| T05 | `write_file_chunk` | 生成一个大约 60KB 的单文件 HTML 压测页面，保存为 `artifacts/tool-trigger-large.html`。 | `path=artifacts/tool-trigger-large.html`，`sequence` 从 1 开始，最后一片 `final=true` | 无 | `write_file` | 首个写入工具是 `write_file_chunk`，并进入写入审批流程 |
| T06 | `write_file` | 创建工作区文件 `artifacts/tool-trigger-small.txt`，内容只有两行：第一行 `tool trigger small file`，第二行 `done`。 | `path=artifacts/tool-trigger-small.txt`，`content` 为完整小文件 | 无 | `write_file_chunk` | 触发 `write_file`，并进入写入审批流程 |
| T07 | `edit_file` | 把 `fixtures/tool-trigger/edit-target.txt` 中唯一的 `color = red` 改成 `color = blue`。 | `path=fixtures/tool-trigger/edit-target.txt`，`old_string=color = red`，`new_string=color = blue` | `read_file` | `write_file`, `write_file_chunk` | 可先触发 `read_file`，随后必须触发 `edit_file` 并进入审批流程 |
| T08 | `install_github_skill` | 从 `$TEST_GITHUB_SKILL_SOURCE` 安装这个 Codex Skill；只完成下载和安装提案，不要启用。 | `source=$TEST_GITHUB_SKILL_SOURCE` | 无 | `activate_skill_install`, `skill_manage`, `manage_skill` | 触发 `install_github_skill`，返回 proposal 后停止或说明下一步 |
| T09 | `activate_skill_install` | 启用安装提案 `$TEST_PROPOSAL_ID` 对应的 GitHub Skill。 | `proposal_id=$TEST_PROPOSAL_ID` | 无 | `install_github_skill`, `skill_manage`, `manage_skill` | 触发 `activate_skill_install`，并进入启用审批流程 |
| T10 | `Skill` | 请使用 `Skill` 工具读取 `$TEST_SKILL_NAME` 的 `SKILL.md`，先不要执行其他操作。 | `skill_name=$TEST_SKILL_NAME`，不传 `file_path` | 无 | `skill_view`, `skills_list` | 精确触发 `Skill`，用于验证大写兼容入口 |
| T11 | `skills_list` | 列出当前可用的 Skills 名称、用途和触发场景。 | 空参数对象 | 无 | `list_installed_skills`, `Skill`, `skill_view` | 触发 `skills_list`，只列可用 skill 索引 |
| T12 | `skill_view` | 请用 Hermes 兼容的 `skill_view` 查看 `$TEST_SKILL_NAME` 的 `SKILL.md`。 | `name=$TEST_SKILL_NAME`，不传 `file_path` | 无 | `Skill`, `skills_list` | 精确触发 `skill_view`，用于验证 Hermes alias |
| T13 | `list_installed_skills` | 列出我当前已安装的 Skills，包括 active、disabled 或 staged 状态和来源。 | 空参数对象 | 无 | `skills_list`, `Skill`, `skill_view` | 触发 `list_installed_skills`，不只列 skill index |
| T14 | `skill_manage` | 创建一个名为 `tool-trigger-note-skill` 的本地 procedural Skill，描述为“记录工具触发测试笔记”，内容为一个最小 `SKILL.md`：当用户要求记录工具触发观察时，整理成中文 Markdown。 | `action=create`，`name=tool-trigger-note-skill`，`description` 和 `content` 填入题目内容 | 无 | `install_github_skill`, `manage_skill` | 触发 `skill_manage`，并进入写入审批流程 |
| T15 | `manage_skill` | 禁用已安装 Skill `$TEST_INSTALLED_SKILL_NAME`。 | `action=disable`，`skill_name=$TEST_INSTALLED_SKILL_NAME` | 无 | `skill_manage`, `activate_skill_install` | 触发 `manage_skill`，并进入启用状态变更审批流程 |

## 可选对照题

这些题用于检查模型是否过度调用工具。

| ID | 目标 | 用户题目 | 期望行为 |
| --- | --- | --- | --- |
| N01 | 不触发 `web_search` | 用三句话解释二分查找是什么。 | 直接回答，不搜索网页 |
| N02 | 不触发 `memory` | 总结一下本轮对话已经做了什么，不要保存成长期记忆。 | 直接总结，不写 memory |
| N03 | 不触发 `session_search` | 根据我刚刚这条消息，提取关键词。 | 使用当前上下文，不查历史 session |
| N04 | 不触发写文件工具 | 给我一段 `hello world` 的 TypeScript 示例，不要保存文件。 | 直接输出代码，不调用 `write_file` 或 `write_file_chunk` |

## 自动化断言建议

事件流测试可以按以下字段断言：

- `targetToolCalled`: 至少出现一次目标 `tool.started` 或模型 `tool_calls`。
- `targetToolFirstWrite`: 对写类测试，目标写工具应是第一个写类工具。
- `unexpectedToolsAbsent`: 未出现题目列出的禁止工具。
- `approvalRequested`: 写类工具、`memory`、`activate_skill_install`、`skill_manage`、`manage_skill` 应进入审批流程。
- `argsMatch`: 参数中的关键字段与题目变量一致。

推荐把每道题转换成结构化测试用例：

```json
{
  "id": "T03",
  "targetTool": "web_search",
  "prompt": "请查一下 Node.js 当前最新 LTS 版本是什么，并给出来源链接。",
  "allowedBefore": [],
  "forbiddenTools": ["session_search", "read_file"],
  "argHints": ["Node.js", "LTS"]
}
```
