<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/tier3-stubs) · [日本語](/docs/ja/features/tier3-stubs)

# Tier 3 — Pure Stubs, N/A Items, and Low-Priority Features

> This document summarizes all Tier 3 features. These features are either pure stubs (all functions return empty values),
> Anthropic-internal infrastructure (N/A), or auxiliary features with very few references.

## Overview

| Feature | References | Status | Category | Summary |
|---------|------|------|------|---------|
| CHICAGO_MCP | 16 | Implemented | Tool | Computer Use control (enabled by default in builds) |
| MONITOR_TOOL | 13 | Implemented | Tool | Background monitoring tool that continuously watches shell output (enabled by default in builds) |
| BG_SESSIONS | 11 | Partially implemented | Session management | Background session registration and cleanup are implemented; task summarization is a stub (enabled by default in development) |
| EXTRACT_MEMORIES | 7 | Implemented | Memory | Automatic memory extraction (enabled by default in builds, gated by GrowthBook) |
| TEMPLATES | 6 | Partially implemented | Project management | Project and prompt template system (enabled by default in development) |
| LODESTONE | 6 | Implemented | Deep links | URL protocol handler (enabled by default in builds) |

## Features with a Single Reference (15)

Each of the following features has only 1 `feature()` reference. Most are internal markers or experimental features:

UNATTENDED_RETRY, ULTRATHINK, TORCH, SLOW_OPERATION_LOGGING, SKILL_IMPROVEMENT,
PERFETTO_TRACING, NATIVE_CLIENT_ATTESTATION, IS_LIBC_MUSL, IS_LIBC_GLIBC,
DUMP_SYSTEM_PROMPT, COMPACTION_REMINDERS, CCR_REMOTE_SETUP,
BUILTIN_EXPLORE_PLAN_AGENTS, BUILDING_CLAUDE_APPS, ABLATION_BASELINE

(`AGENT_TRIGGERS` used to be listed here; it actually has 3 references and has been moved out.)

## Feature Names with No Remaining Call Sites

The following names have **no `feature()` call sites at all** in `src/` or `packages/`. They are kept only as
historical record — do not treat them as flags that can be enabled:
SHOT_STATS, SELF_HOSTED_RUNNER, RUN_SKILL_GENERATOR, BYOC_ENVIRONMENT_RUNNER,
ANTI_DISTILLATION_CC, KAIROS_DREAM

## Priority Rationale

These features are classified as Tier 3 for the following reasons:

1. **Implemented with limited impact** (CHICAGO_MCP, LODESTONE, EXTRACT_MEMORIES, MONITOR_TOOL): These features are enabled by default in builds or development and primarily serve as infrastructure for other features
2. **Partially implemented** (BG_SESSIONS, TEMPLATES): Core registration is implemented, but some functionality, such as task summarization, remains a stub
3. **Auxiliary features** (STREAMLINED_OUTPUT, HOOK_PROMPTS): These features have limited impact
4. **CCR family**: These features depend on the remote control infrastructure and require BRIDGE_MODE to be completed first

To investigate a Tier 3 feature in detail, search the repository for `feature('FEATURE_NAME')` to inspect its specific use cases.
