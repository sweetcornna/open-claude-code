# Chrome Use — 用户配置的浏览器 MCP

occ 不内置或自动注入 Chrome MCP。下面的 `hangwin/mcp-chrome` 是第三方扩展，需像其他 MCP server 一样由用户自行安装和配置。

## 安装扩展

1. 从 https://github.com/hangwin/mcp-chrome/releases 下载扩展
2. 解压 zip 文件
3. 打开 Chrome 的 `chrome://extensions/`
4. 开启「开发者模式」
5. 点击「加载已解压的扩展程序」，选择解压后的目录

## 添加 MCP 配置

扩展启动本地服务后，用普通 MCP 命令添加它：

```bash
occ mcp add --scope user --transport http \
  --header "Authorization: Bearer my-static-token" \
  mcp-chrome http://127.0.0.1:12306/mcp
```

如果扩展配置了不同的端口或 token，请同步修改命令。server 名称也可自行选择；`mcp-chrome` 和 `chrome-devtools` 都不是 occ 保留名。随后可用 `/mcp` 查看连接状态。

## 相关文档

- GitHub 仓库：https://github.com/hangwin/mcp-chrome
- [MCP 配置](/docs/zh/extensibility/mcp-configuration)
