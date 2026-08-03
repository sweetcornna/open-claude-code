# 自动更新

## 当前策略

Open Claude Code 通过 npm 包 `@sweetcornna/open-claude-code` 发布（无 scope 的 `open-claude-code` 已被第三方占位包占用）。当前受支持的更新入口是：

```bash
occ update
```

该命令只检查并更新 Open Claude Code 自己，不会安装、卸载或覆盖 Anthropic 官方 Claude Code。

官方 CLI 与 occ 可以并存：

| 产品 | 命令 | npm 包 | 用户配置 |
|---|---|---|---|
| Open Claude Code | `occ` / `occ-bun` | `@sweetcornna/open-claude-code` | `~/.occ/`、`~/.occ.json` |
| Anthropic Claude Code | `claude` | `@anthropic-ai/claude-code` | `~/.claude/`、`~/.claude.json` |

## 安装与手动更新

使用 npm 安装或更新：

```bash
npm install -g @sweetcornna/open-claude-code
occ update
```

使用 Bun 安装或更新：

```bash
bun install -g @sweetcornna/open-claude-code
occ-bun update
```

也可以绕过自动检测，直接运行对应包管理器命令：

```bash
npm install -g @sweetcornna/open-claude-code@latest
# 或
bun install -g @sweetcornna/open-claude-code@latest
```

## `occ update` 的执行流程

实现位于 `src/cli/updateOcc.ts`，流程如下：

1. 读取当前版本。
2. 从 npm registry 查询 `@sweetcornna/open-claude-code@latest`。
3. 如果当前版本已是最新版本，则直接退出。
4. 检测当前安装是否位于 Bun 的全局安装目录。
5. Bun 全局安装使用 `bun install -g @sweetcornna/open-claude-code@latest`；其他安装使用 `npm install -g @sweetcornna/open-claude-code@latest`。
6. 更新失败时打印等价的手动恢复命令。

包名来自 `src/constants/brand.ts` 的 `NPM_PACKAGE_NAME`，不是在更新器中重复维护的字符串。

## 与官方原生安装器的隔离

仓库保留了一部分从上游恢复的原生安装器实现，供代码研究和后续独立发行基础设施建设参考。它所指向的是 Anthropic 的官方二进制分发渠道，不是 Open Claude Code 的发布渠道，因此 **不属于 occ 当前支持的安装方式**。

为保证两个产品互不干扰：

- 根命令不注册 `occ install [target]` 原生安装入口。
- occ 的更新入口不会下载 Anthropic 官方二进制。
- occ 不会卸载 `@anthropic-ai/claude-code`。
- occ 不会删除或替换 `claude` 命令。
- occ 不会把 `~/.claude` 当作自己的可写安装目录。

不要通过手工调用 `src/utils/nativeInstaller/` 下的内部函数安装 occ；这些函数不是稳定的公共接口。

## 后台更新组件

`src/components/AutoUpdaterWrapper.tsx` 中仍保留 JavaScript 包更新与外部包管理器通知组件的路由代码，但当前产品入口没有挂载该组件。它也不再路由到 `NativeAutoUpdater`。

因此，发布版本的可靠更新契约是显式执行 `occ update`。在 occ 建立自己的签名二进制发布源之前，不应重新接通继承的原生下载器或官方包管理器更新提示。

## 开发版本

源码工作区应通过 Git 和依赖安装更新，而不是依赖全局 CLI 更新当前 checkout：

```bash
git pull
bun install
bun run precheck
```

需要验证发布产物时运行：

```bash
bun run build:vite
node dist/cli-node.js --version
bun dist/cli-bun.js --version
```

## 故障排查

如果 `occ update` 无法访问 npm registry，可直接检查包版本：

```bash
npm view @sweetcornna/open-claude-code@latest version
```

如果全局安装缺少写权限，修复 npm/Bun 的用户级全局目录配置；不要通过删除 `~/.claude`、卸载官方 Claude Code 或覆盖 `claude` 命令来解决。

更新后可确认两个命令仍彼此独立：

```bash
occ --version
claude --version
```

未安装官方 Claude Code 时，第二条命令不存在是正常情况。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/constants/brand.ts` | occ 命令名和 npm 包名的唯一真源 |
| `src/cli/updateOcc.ts` | `occ update` 的版本检查与 npm/Bun 更新流程 |
| `src/main.tsx` | 注册 `occ update` 根命令 |
| `src/components/AutoUpdaterWrapper.tsx` | 未挂载的后台更新路由；不得连接官方原生下载器 |
| `src/utils/nativeInstaller/` | 继承的非公共原生安装器实现，不是 occ 发布渠道 |
