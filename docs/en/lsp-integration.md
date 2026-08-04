<!-- lang-switcher -->
**English** · [中文](/docs/zh/lsp-integration) · [日本語](/docs/ja/lsp-integration)

# LSP Integration

Claude Code includes Language Server Protocol (LSP) integration. It provides code-intelligence operations (go to definition, find references, hover information, document symbols, and more) together with passive diagnostic feedback.

## Quick Start

### 1. Install an LSP Plugin

Use the `/plugin` command in the Claude Code REPL to search for and install an LSP plugin:

```
/plugin
```

Search for `lsp`, locate the plugin for the relevant language (for example, `typescript-lsp`), and install it.

After installation, run `/reload-plugins` to activate the plugin.

Once an LSP plugin is installed, the background LSP Server Manager automatically loads and starts the corresponding language server. No manual configuration is required.

### 2. Enable the LSP Tool

The LSP Tool must be enabled explicitly through an environment variable before Claude can initiate code-intelligence queries:

```bash
ENABLE_LSP_TOOL=1 bun run dev
```

When the tool is not enabled, the LSP servers still run in the background and push passive diagnostic feedback such as type errors.

## Automatic Recommendations

In addition to manual installation through `/plugin`, Claude Code automatically checks for LSP plugins when files are edited:

1. Watch `fileHistory.trackedFiles` for newly edited files
2. Scan installed marketplaces for an LSP plugin that declares support for the file extension
3. Check whether the corresponding LSP binary (such as `typescript-language-server`) is installed on the system
4. If all conditions are met, show a recommendation dialog that offers to install the plugin

```
┌───── LSP Plugin Recommendation ─────────────┐
│                                               │
│  LSP provides code intelligence like          │
│  go-to-definition and error checking          │
│                                               │
│  Plugin: typescript-lsp                       │
│  Triggered by: .ts files                     │
│                                               │
│  Would you like to install this LSP plugin?   │
│                                               │
│  > Yes, install typescript-lsp               │
│    No, not now                                │
│    Never for typescript-lsp                   │
│    Disable all LSP recommendations            │
└───────────────────────────────────────────────┘
```

- The dialog closes automatically after 30 seconds without input (treated as “No”)
- Selecting “Never” suppresses future recommendations for that plugin
- Selecting “Disable” turns off all LSP recommendations
- Recommendations are disabled automatically after they are ignored 5 consecutive times

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    LSP Tool                         │
│  packages/builtin-tools/src/tools/LSPTool/LSPTool.ts│
│  (Claude-callable tool with 9 operations)           │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              LSP Server Manager (Singleton)          │
│  src/services/lsp/manager.ts                        │
│  - initializeLspServerManager()                     │
│  - reinitializeLspServerManager()                   │
│  - shutdownLspServerManager()                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│           LSP Server Manager (instance)              │
│  src/services/lsp/LSPServerManager.ts               │
│  - Manages multiple LSPServerInstance objects       │
│  - Routes requests by file extension                │
│  - File sync (didOpen/didChange/didSave/didClose)   │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ LSPServer    │ │ LSPServer    │ │ LSPServer    │
│ Instance     │ │ Instance     │ │ Instance     │
│ (typescript) │ │ (python)     │ │ (rust...)    │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
┌──────▼───────┐ ┌──────▼───────┐ ┌──────▼───────┐
│ LSPClient    │ │ LSPClient    │ │ LSPClient    │
│ (JSON-RPC)   │ │ (JSON-RPC)   │ │ (JSON-RPC)   │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
 subprocess (stdio) subprocess (stdio) subprocess (stdio)
```

### Passive Diagnostic Feedback

```
LSP Server ──publishDiagnostics──▶ passiveFeedback.ts
                                          │
                                          ▼
                                   LSPDiagnosticRegistry
                                   (deduplication, capacity limits)
                                          │
                                          ▼
                                   Attachment System
                                   (asynchronous conversation injection)
```

LSP servers asynchronously push `textDocument/publishDiagnostics` notifications. After deduplication and capacity limiting, the system injects them into Claude's conversation context as attachments.

## Core Modules

| File | Responsibility |
|------|------|
| `src/services/lsp/manager.ts` | Global singleton; manages initialization, reinitialization, and shutdown lifecycles |
| `src/services/lsp/LSPServerManager.ts` | Manages multiple servers, routes by file extension, and synchronizes files |
| `src/services/lsp/LSPServerInstance.ts` | Lifecycle of one LSP server instance (start/stop/restart/health check) |
| `src/services/lsp/LSPClient.ts` | JSON-RPC communication layer (based on `vscode-jsonrpc`) and subprocess management |
| `src/services/lsp/config.ts` | Loads LSP server configuration from plugins |
| `src/services/lsp/LSPDiagnosticRegistry.ts` | Registers and deduplicates diagnostics and enforces capacity limits |
| `src/services/lsp/passiveFeedback.ts` | Registers the `publishDiagnostics` notification handler |
| `packages/builtin-tools/src/tools/LSPTool/LSPTool.ts` | LSP Tool implementation exposed to Claude |
| `packages/builtin-tools/src/tools/LSPTool/schemas.ts` | Input schema (a discriminated union of 9 operations) |
| `packages/builtin-tools/src/tools/LSPTool/formatters.ts` | Formats results for each operation |
| `packages/builtin-tools/src/tools/LSPTool/prompt.ts` | Tool description text |
| `src/utils/plugins/lspPluginIntegration.ts` | Loading from plugins, validation, environment-variable resolution, and scope management |

## Operations Supported by the LSP Tool

| Operation | LSP Method | Description |
|------|-----------|------|
| `goToDefinition` | `textDocument/definition` | Go to a symbol's definition |
| `findReferences` | `textDocument/references` | Find all references |
| `hover` | `textDocument/hover` | Retrieve hover information (documentation and type) |
| `documentSymbol` | `textDocument/documentSymbol` | Retrieve all symbols in a document |
| `workspaceSymbol` | `workspace/symbol` | Search symbols across the workspace |
| `goToImplementation` | `textDocument/implementation` | Find implementations of an interface or abstract method |
| `prepareCallHierarchy` | `textDocument/prepareCallHierarchy` | Retrieve the call-hierarchy item at a position |
| `incomingCalls` | `callHierarchy/incomingCalls` | Find all functions that call this function |
| `outgoingCalls` | `callHierarchy/outgoingCalls` | Find all functions called by this function |

Every operation requires the `filePath`, `line` (1-based), and `character` (1-based) arguments.

## Plugin Development: LSP Server Configuration

Plugins provide LSP servers. A plugin's `manifest.json` can declare LSP servers in three formats:

**1. Inline configuration (defined directly in the manifest)**

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      }
    }
  }
}
```

**2. Reference to an external .lsp.json file**

```json
{
  "lspServers": "path/to/.lsp.json"
}
```

**3. Mixed array format**

```json
{
  "lspServers": [
    "path/to/.lsp.json",
    {
      "another-server": { "command": "...", "extensionToLanguage": { "...": "..." } }
    }
  ]
}
```

A `.lsp.json` file can also be placed directly in the plugin directory without declaring it in the manifest.

### LSP Server Configuration Schema

| Field | Type | Required | Description |
|------|------|------|------|
| `command` | string | Yes | LSP server executable command (without spaces) |
| `args` | string[] | No | Command-line arguments |
| `extensionToLanguage` | `Record<string, string>` | Yes | Map from file extensions to language IDs (at least one) |
| `transport` | `"stdio"` \| `"socket"` | No | Transport; defaults to `stdio` |
| `env` | `Record<string, string>` | No | Environment variables set when starting the server |
| `initializationOptions` | unknown | No | Initialization options passed to the server |
| `settings` | unknown | No | Settings passed through `workspace/didChangeConfiguration` |
| `workspaceFolder` | string | No | Workspace directory path |
| `startupTimeout` | number | No | Startup timeout (milliseconds) |
| `maxRestarts` | number | No | Maximum number of restarts (default: 3) |

### Environment Variable Substitution

The `command`, `args`, `env`, and `workspaceFolder` fields support:

- `${CLAUDE_PLUGIN_ROOT}` — Plugin root directory
- `${CLAUDE_PLUGIN_DATA}` — Plugin data directory
- `${user_config.KEY}` — Value configured by the user when enabling the plugin
- `${VAR}` — System environment variable

## Lifecycle Management

### Server State Machine

```
stopped → starting → running
running → stopping → stopped
any     → error (on failure)
error   → starting (on retry)
```

### Crash Recovery

- When an LSP server crashes, set its state to `error`
- On the next request, automatically attempt a restart through `ensureServerStarted`
- Stop retrying after `maxRestarts` attempts (default: 3)

### Transient Error Retries

- Automatically retry `ContentModified` errors (LSP error code -32801), up to 3 times
- Use exponential backoff: 500ms → 1000ms → 2000ms
- These errors commonly occur with servers such as rust-analyzer while they are still indexing the project

### Diagnostic Capacity Limits

- At most 10 diagnostics per file
- At most 30 diagnostics in total
- Sort excess diagnostics by severity and truncate them (Error > Warning > Info > Hint)
- Deduplicate across turns: do not resend identical diagnostics that have already been sent
- After a file is edited, clear that file's sent records so new diagnostics can pass through

### Plugin Refresh

After installing or uninstalling a plugin, run `/reload-plugins`. It calls `reinitializeLspServerManager()`:
1. Shut down old server instances asynchronously
2. Reset the state to `not-started`
3. Call `initializeLspServerManager()` to reload plugin configuration

## Dependencies

- `vscode-jsonrpc` — JSON-RPC communication (loaded lazily with require only when a server instance is actually created)
- `vscode-languageserver-protocol` — LSP protocol types
- `vscode-languageserver-types` — LSP type definitions
- `lru-cache` — Diagnostic deduplication cache
