<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/experimental-skill-search) · [日本語](/docs/ja/features/experimental-skill-search)

# EXPERIMENTAL_SKILL_SEARCH — Semantic Skill Search

> Feature Flag: `FEATURE_EXPERIMENTAL_SKILL_SEARCH=1`
> Implementation status: Entirely stubbed (8 files); wiring complete
> Reference count: 21

## 1. Feature overview

EXPERIMENTAL_SKILL_SEARCH provides the DiscoverSkills tool, which semantically searches available skills for the current task. Its goal is to let the model discover and recommend relevant local and remote skills automatically while performing a task, without requiring the user to search manually.

## 2. Implementation architecture

### 2.1 Module status

| Module | File | Status | Description |
|------|------|------|------|
| DiscoverSkillsTool | `src/tools/DiscoverSkillsTool/prompt.ts` | **Stub** | Empty tool name |
| Prefetch | `src/services/skillSearch/prefetch.ts` | **Stub** | All three functions are no-ops |
| Remote loading | `src/services/skillSearch/remoteSkillLoader.ts` | **Stub** | Returns an empty result |
| Remote state | `src/services/skillSearch/remoteSkillState.ts` | **Stub** | Returns null/undefined |
| Signals | `src/services/skillSearch/signals.ts` | **Stub** | `DiscoverySignal = any` |
| Telemetry | `src/services/skillSearch/telemetry.ts` | **Stub** | No-op logging |
| Local search | `src/services/skillSearch/localSearch.ts` | **Stub** | No-op cache |
| Feature check | `src/services/skillSearch/featureCheck.ts` | **Stub** | `isSkillSearchEnabled => false` |
| SkillTool integration | `src/tools/SkillTool/SkillTool.ts` | **Wired** | Dynamically loads every remote-skill module |
| Prompt integration | `src/constants/prompts.ts` | **Wired** | Injects the DiscoverSkills schema |

### 2.2 Expected data flow

```
Model processes the user's task
      │
      ▼
DiscoverSkills tool triggers [implementation required]
      │
      ├── Local search: index installed skill metadata
      │   └── localSearch.ts → match skill names/descriptions/keywords
      │
      └── Remote search: query a skill marketplace/registry
          └── remoteSkillLoader.ts → fetch + parse
      │
      ▼
Rank and filter results
      │
      ▼
Return a list of recommended skills
      │
      ▼
Model invokes a recommended skill through SkillTool
```

### 2.3 Prefetch mechanism

`prefetch.ts` is intended to analyze message content and search for relevant skills before the user submits the input:

- `startSkillDiscoveryPrefetch()` — start prefetching
- `collectSkillDiscoveryPrefetch()` — collect prefetch results
- `getTurnZeroSkillDiscovery()` — get skill-discovery results for turn 0

## 3. Incomplete work

| Priority | Module | Effort | Description |
|--------|------|--------|------|
| 1 | `DiscoverSkillsTool` | Large | Semantic-search tool schema and execution |
| 2 | `skillSearch/prefetch.ts` | Medium | User-input analysis and prefetch logic |
| 3 | `skillSearch/remoteSkillLoader.ts` | Large | Fetching from a remote marketplace/registry |
| 4 | `skillSearch/remoteSkillState.ts` | Small | State management for discovered skills |
| 5 | `skillSearch/localSearch.ts` | Medium | Local index construction and querying |
| 6 | `skillSearch/featureCheck.ts` | Small | GrowthBook/configuration gating |
| 7 | `skillSearch/signals.ts` | Small | `DiscoverySignal` type definition |

## 4. Key design decisions

1. **Prefetch optimization**: Begin searching before the user submits the input to reduce initial-response latency
2. **Combined local and remote search**: Fast matching against a local index plus deeper searching of a remote marketplace
3. **SkillTool integration**: Invoke discovered skills through SkillTool; no new invocation mechanism is required
4. **Independent of MCP_SKILLS**: MCP_SKILLS discovers skills from MCP servers, while EXPERIMENTAL_SKILL_SEARCH discovers them from skill marketplaces

## 5. Usage

```bash
# Enable the feature (it is not functional until the implementation is completed)
FEATURE_EXPERIMENTAL_SKILL_SEARCH=1 bun run dev
```

## 6. File index

| File | Responsibility |
|------|------|
| `src/tools/DiscoverSkillsTool/prompt.ts` | Tool schema (stub) |
| `src/services/skillSearch/prefetch.ts` | Prefetch logic (stub) |
| `src/services/skillSearch/remoteSkillLoader.ts` | Remote loading (stub) |
| `src/services/skillSearch/remoteSkillState.ts` | Remote state (stub) |
| `src/services/skillSearch/signals.ts` | Signal types (stub) |
| `src/services/skillSearch/telemetry.ts` | Telemetry (stub) |
| `src/services/skillSearch/localSearch.ts` | Local search (stub) |
| `src/services/skillSearch/featureCheck.ts` | Feature check (stub) |
| `src/tools/SkillTool/SkillTool.ts` | SkillTool integration point |
| `src/constants/prompts.ts:95,335,778` | Prompt augmentation |
