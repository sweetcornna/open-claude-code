<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/tier3-stubs) · [日本語](/docs/ja/features/tier3-stubs)

# Tier 3 — Pure Stubs, N/A Items, and Low-Priority Features

> This document summarizes all Tier 3 features. These features are either pure stubs (all functions return empty values),
> Anthropic-internal infrastructure (N/A), or auxiliary features with very few references.

## Overview

| Feature | References | Status | Category | Summary |
|---------|------|------|------|---------|
| CHICAGO_MCP | 16 | Implemented | Tool | Computer Use + Chrome MCP control (enabled by default in builds) |
| MONITOR_TOOL | 13 | Implemented | Tool | Background monitoring tool that continuously watches shell output (enabled by default in builds) |
| BG_SESSIONS | 11 | Partially implemented | Session management | Background session registration and cleanup are implemented; task summarization is a stub (enabled by default in development) |
| SHOT_STATS | 10 | Implemented | Metrics | API call statistics panel (enabled by default in builds) |
| EXTRACT_MEMORIES | 7 | Implemented | Memory | Automatic memory extraction (enabled by default in builds, gated by GrowthBook) |
| TEMPLATES | 6 | Partially implemented | Project management | Project and prompt template system (enabled by default in development) |
| LODESTONE | 6 | Implemented | Deep links | URL protocol handler (enabled by default in builds) |

## Features with a Single Reference (40+)

Each of the following features has only 1 reference. Most are internal markers or experimental features:

UNATTENDED_RETRY, ULTRATHINK, TORCH, SLOW_OPERATION_LOGGING, SKILL_IMPROVEMENT,
SELF_HOSTED_RUNNER, RUN_SKILL_GENERATOR, PERFETTO_TRACING, NATIVE_CLIENT_ATTESTATION,
KAIROS_DREAM (see kairos.md), IS_LIBC_MUSL, IS_LIBC_GLIBC, DUMP_SYSTEM_PROMPT,
COMPACTION_REMINDERS, CCR_REMOTE_SETUP, BYOC_ENVIRONMENT_RUNNER, BUILTIN_EXPLORE_PLAN_AGENTS,
BUILDING_CLAUDE_APPS, ANTI_DISTILLATION_CC, AGENT_TRIGGERS, ABLATION_BASELINE

## Priority Rationale

These features are classified as Tier 3 for the following reasons:

1. **Implemented with limited impact** (CHICAGO_MCP, LODESTONE, SHOT_STATS, EXTRACT_MEMORIES, MONITOR_TOOL): These features are enabled by default in builds or development and primarily serve as infrastructure for other features
2. **Partially implemented** (BG_SESSIONS, TEMPLATES): Core registration is implemented, but some functionality, such as task summarization, remains a stub
3. **Auxiliary features** (STREAMLINED_OUTPUT, HOOK_PROMPTS): These features have limited impact
4. **CCR family**: These features depend on the remote control infrastructure and require BRIDGE_MODE to be completed first

To investigate a Tier 3 feature in detail, search the repository for `feature('FEATURE_NAME')` to inspect its specific use cases.
