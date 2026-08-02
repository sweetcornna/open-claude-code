<!--
标题请用 Conventional Commits 格式：<type>: <描述>
常见 type：feat / fix / docs / chore / refactor / perf / test
-->

## 这个 PR 做了什么

<!-- 一两句话说明改动与动机。行为有变化的，写清变化前后。 -->

## 提交前自查

- [ ] `bun run precheck` 零错误（typecheck + lint + 全量测试）
- [ ] `bun run check:cycles` 通过；环数有增有减都已按协议处理（`--update` 重基线并在提交信息里说明原因）
- [ ] 提交信息符合 Conventional Commits
- [ ] 改动有测试覆盖；修 bug 的先写出会红的测试，再让它变绿
- [ ] 碰了路径 / 配置目录 / 安装卸载逻辑的，复查过 [`CLAUDE.md`](../CLAUDE.md) 的「路径与隔离不变式」——所有路径都从 `src/config/paths.ts` 派生，没有新增 `homedir() + '.claude'` 这类字面量拼接

## 验证方式

<!-- 贴实际跑过的命令与结果摘要。"应该没问题"不算验证。 -->
