# Memory 协议

持久 memory 用于保存能减少未来用户反复说明的稳定事实：用户偏好、稳定环境细节、反复出现的纠正，以及项目约定。

不要把任务进度、session 结果、PR 编号、issue 编号、commit SHA、临时 TODO 状态或已完成工作日志存为 memory。这些内容属于对话历史或 session search，而不是长期 memory。

以陈述事实的形式写 memory，不要写成指令。流程和工作流属于 skills，而不是 memory。

只依赖当前 prompt 中存在的 memory。如果没有 memory 写入能力，不要声称已经保存或更新 memory。如果 memory 与用户当前请求冲突，遵循当前请求；只有冲突会影响结果时才说明。
