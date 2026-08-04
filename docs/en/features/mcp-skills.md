<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/mcp-skills) · [日本語](/docs/ja/features/mcp-skills)

# MCP_SKILLS — MCP Skill Discovery

> Feature Flag: `FEATURE_MCP_SKILLS=1`
> Implementation status: Functional implementation (the config-gated filter is complete; the core fetcher is a stub)
> Reference count: 9

## 1. Feature overview

MCP_SKILLS discovers resources exposed by MCP servers (using the `skill://` URI scheme) and converts them into invocable skill commands. MCP servers can provide tools, prompts, and resources concurrently; when this feature is enabled, resources with `skill://` URIs are recognized as skills.

### Core capabilities

- **Automatic discovery**: Fetches `skill://` resources automatically when an MCP server connects
- **Command conversion**: Converts MCP resources into `prompt`-type Command objects
- **Live refresh**: Refetches skills when the prompts/resources lists change
- **Cache consistency**: Clears the skill cache when a connection closes

## 2. Implementation architecture

### 2.1 Data flow

```
MCP Server connection
      │
      ▼
client.ts: connectToServer / setupMcpClientConnections
  ├── fetchToolsForClient      (MCP tools)
  ├── fetchCommandsForClient   (MCP prompts → Command objects)
  ├── fetchMcpSkillsForClient  (MCP skill:// resources → Command objects) [MCP_SKILLS]
  └── fetchResourcesForClient  (MCP resources)
      │
      ▼
commands = [...mcpPrompts, ...mcpSkills]
      │
      ▼
AppState.mcp.commands updated
      │
      ▼
getMcpSkillCommands() filters → SkillTool invocation
```

### 2.2 Skill filtering

File: `src/commands.ts:604-616`

`getMcpSkillCommands(mcpCommands)` applies these conditions:

```ts
cmd.type === 'prompt'                  // Must be the prompt type
cmd.loadedFrom === 'mcp'               // Must originate from an MCP server
!cmd.disableModelInvocation            // Must be invocable by the model
feature('MCP_SKILLS')                  // The feature flag must be enabled
```

### 2.2.1 Frontmatter allowlist (security boundary)

A **remote server** controls an MCP skill's frontmatter, while the user approves only "use this skill." Therefore, before any field of a skill with `loadedFrom === 'mcp'` is consumed, `restrictMcpSkillFrontmatter()` restricts it to a closed allowlist that retains only plain metadata:

```
name  description  argument-hint  arguments  when_to_use
version  disable-model-invocation  user-invocable
license  compatibility  metadata
```

`allowed-tools`, `hooks`, `shell`, `model`, `context`, `agent`, `effort`, and `paths` are always stripped. Otherwise, a remote server could use a single skill authorization to preauthorize tools for the current turn or register a session hook that executes shell commands, without the UI ever disclosing that behavior. The implementation uses an **allowlist rather than a denylist**, so future privilege-bearing fields are rejected by default.

The discovery phase also enforces resource limits: at most 32 skills per server, 256 KiB per item, 1 MiB in total, and a 10-second overall timeout. These limits prevent a malicious server from blocking connection initialization or exhausting memory with an oversized `resources/list` response.

### 2.3 Conditional loading

File: `src/services/mcp/client.ts:129-133`

`fetchMcpSkillsForClient` is loaded conditionally through `require()`; when the feature flag is disabled, no module is loaded:

```ts
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? require('../../skills/mcpSkills.js').fetchMcpSkillsForClient
  : null
```

### 2.4 Cache management

The skill fetcher maintains a `.cache` (Map) and clears it at these points:

| Event | Behavior |
|------|------|
| Connection closes | Clear that client's skill cache |
| `disconnectMcpServer()` | Clear the skill cache |
| `prompts/list_changed` notification | Refresh prompts and fetch skills in parallel |
| `resources/list_changed` notification | Refresh resources, prompts, and skills |

### 2.5 Integration points

| File | Lines | Description |
|------|------|------|
| `src/commands.ts` | 604-616, 620-633 | Command filtering and SkillTool command collection |
| `src/services/mcp/client.ts` | 129-133, 1394, 1672, 2176 | Skill fetching, cache clearing, and fetching on connection |
| `src/services/mcp/useManageMCPConnections.ts` | 22-26, 682-740 | Live refresh when prompts/resources change |

## 3. Key design decisions

1. **Feature-gate isolation**: `feature('MCP_SKILLS')` guards the conditional `require()` and every call site. When disabled, the module is not loaded and no fetch occurs
2. **Resource-to-skill mapping**: Skills are discovered from resources with `skill://` URIs on MCP servers. `fetchMcpSkillsForClient` performs the conversion (currently a stub)
3. **Avoiding circular dependencies**: `mcpSkillBuilders.ts` is a leaf in the dependency graph, preventing a `client.ts ↔ mcpSkills.ts ↔ loadSkillsDir.ts` cycle
4. **Server capability check**: Fetching skills also requires the MCP server to support resources (`!!client.capabilities?.resources`)

## 4. Usage

```bash
# Enable the feature
FEATURE_MCP_SKILLS=1 bun run dev

# Prerequisites:
# 1. An MCP server that supports skill:// resources is configured
# 2. The MCP server declares the resources capability
```

## 5. Incomplete work

| File | Status | Required implementation |
|------|------|---------|
| `src/skills/mcpSkills.ts` | Stub | `fetchMcpSkillsForClient()` — filter `skill://` URIs from the MCP resource list and convert them into Command objects |
| `src/skills/mcpSkillBuilders.ts` | Stub | Register skill builders (while avoiding circular dependencies) |

## 6. File index

| File | Responsibility |
|------|------|
| `src/commands.ts:547-608` | Skill command filtering |
| `src/services/mcp/client.ts:117-2358` | Skill fetching and cache management |
| `src/services/mcp/useManageMCPConnections.ts` | Live refresh |
| `src/skills/mcpSkills.ts` | Core conversion logic (stub) |
