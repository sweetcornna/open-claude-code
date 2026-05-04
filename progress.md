# Code Review Progress

## 2026-05-03 — 第一轮 CRUD 业务逻辑层 Code Review

### 审查范围
审查了 4 个核心 CRUD 模块：任务管理(tasks.ts)、设置管理(settings.ts)、插件管理(installedPluginsManager.ts)、团队协作邮箱(teammateMailbox.ts)。

### 变更内容
1. **新增 `src/utils/__tests__/tasks.test.ts`** — 37 个测试覆盖完整 CRUD 操作：创建/读取/更新/删除任务、高水位标记防 ID 复用、文件锁并发安全、blockTask 双向关系、claimTask 竞态保护（含 agent_busy 检查）、resetTaskList、通知信号机制、并发创建唯一 ID 验证。

### Code Review 发现
- tasks.ts 架构合理，文件锁+高水位标记保证了并发安全
- settings.ts 依赖链过深（MDM/远程管理/文件系统），63 个现有测试覆盖良好
- installedPluginsManager.ts V1→V2 迁移逻辑清晰，内存/磁盘状态分离设计良好
- teammateMailbox.ts 25 个现有测试覆盖纯函数，协议消息检测函数完整

## 2026-05-05 — 第一轮用户思维 Design Review

### 审查范围
从用户视角审视 CLI 交互体验：Onboarding 流程、Trust Dialog、错误消息、Help Menu。聚焦非代码层面的用户友好性问题。

### 发现的不友好问题
1. **错误消息缺乏可操作提示**：budget 超限/max turns 用尽时仅告知"出错了"，未指导用户如何继续
2. **Onboarding 安全说明冰冷**："Security notes"标题过于技术化，用户容易跳过
3. **Trust Dialog 文案冗长**：安全检查对话框用语偏官方，核心信息被淹没

### 变更内容
1. **`src/cli/print.ts`** — 为 3 种错误子类型（budget/turns/structured-output）添加 Tip 提示行，告知用户具体的解决方式
2. **`src/QueryEngine.ts`** — 预算超限错误消息添加 `--max-budget-usd` 指引
3. **`src/components/Onboarding.tsx`** — 安全步骤标题改为 "Before you start, keep in mind"，条目文案更口语化
4. **`src/components/TrustDialog/TrustDialog.tsx`** — 精简为两句核心信息，降低认知负荷
5. **`src/cli/__tests__/userFacingErrorMessages.test.ts`** — 7 个测试验证消息内容包含关键引导信息
