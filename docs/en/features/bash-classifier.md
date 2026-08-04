<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/bash-classifier) · [日本語](/docs/ja/features/bash-classifier)

# BASH_CLASSIFIER — Bash Command Classifier

> Feature Flag: `FEATURE_BASH_CLASSIFIER=1`
> Implementation status: All of bashClassifier.ts is stubbed; yoloClassifier.ts provides a complete reference implementation
> Reference count: 45

## 1. Feature overview

BASH_CLASSIFIER uses an LLM to classify the intent of Bash commands (allow/deny/ask) and make automatic permission decisions. Users do not need to approve every Bash command individually; the classifier evaluates safety automatically from the command's content and context.

### Core capabilities

- **LLM-driven classification**: Uses the Opus model to assess command safety
- **Two-stage classification**: Fast deny/allow stage followed by deeper chain-of-thought analysis
- **Automatic approval**: Commands classified as safe pass automatically
- **UI integration**: The permission dialog displays classifier status and review options

## 2. Implementation architecture

### 2.1 Module status

| Module | File | Status | Description |
|------|------|------|------|
| Bash classifier | `src/utils/permissions/bashClassifier.ts` | **Stub** | Every function is a no-op. Comment: “ANT-ONLY” |
| YOLO classifier | `src/utils/permissions/yoloClassifier.ts` | **Complete** | 1496-line, two-stage XML classifier |
| Approval signals | `src/utils/classifierApprovals.ts` | **Complete** | Map and signals manage classifier decisions |
| Permission UI | `src/components/permissions/BashPermissionRequest.tsx` | **Wired** | Classifier status display and review options |
| Permission pipeline | `src/hooks/toolPermission/handlers/*.ts` | **Wired** | Routes classifier results into decisions |
| API beta header | `src/services/api/withRetry.ts` | **Wired** | Sends the `bash_classifier` beta when enabled |

### 2.2 Reference implementation: yoloClassifier.ts

File: `src/utils/permissions/yoloClassifier.ts` (1496 lines)

This complete classifier implementation is the reference for bashClassifier.ts:

```
Two-stage classification:
1. Fast stage: build conversation transcript → call sideQuery (Opus) → fast deny/allow
2. Deep stage: chain-of-thought analysis → final decision
```

Capabilities:
- Builds context from the complete conversation transcript
- Calls sideQuery with a safety system prompt
- Includes GrowthBook configuration and metrics
- Handles errors and degradation

### 2.3 Position in the permission pipeline

```
Bash command arrives
      │
      ▼
bashPermissions.ts permission check
      │
      ├── Traditional rule matching (string level)
      │
      └── [BASH_CLASSIFIER] LLM classification
            │
            ├── allow → pass automatically
            ├── deny → reject automatically
            └── ask → display permission dialog
                  │
                  ├── Classifier automatic-approval marker
                  └── Review option (user can override)
```

## 3. Incomplete work

| Function | Required implementation | Description |
|------|---------|------|
| `classifyBashCommand()` | Call an LLM to assess safety | Follow the two-stage pattern in yoloClassifier.ts |
| `isClassifierPermissionsEnabled()` | Check GrowthBook/configuration | Controls whether the classifier is active |
| `getBashPromptDenyDescriptions()` | Return prompt-based deny rules | Permission-setting descriptions |
| `getBashPromptAskDescriptions()` | Return ask rules | Commands that require user confirmation |
| `getBashPromptAllowDescriptions()` | Return allow rules | Commands that pass automatically |
| `generateGenericDescription()` | Use an LLM to generate a command description | Supplies an explanation to the permission dialog |
| `extractPromptDescription()` | Parse rule content | Extracts a description from a rule |

## 4. Key design decisions

1. **ANT-ONLY marker**: bashClassifier.ts is marked “ANT-ONLY” and may be a client adapter for Anthropic's internal server-side classifier
2. **Two-stage classification**: The fast stage handles clear cases to reduce latency; the deep stage handles ambiguous cases
3. **Classifier results are reviewable**: The permission UI displays the classifier's decision, which the user can override
4. **YOLO classifier as reference**: yoloClassifier.ts provides the complete classifier implementation pattern and can be followed directly

## 5. Usage

```bash
# Enable the feature
FEATURE_BASH_CLASSIFIER=1 bun run dev

# Use with TREE_SITTER_BASH (AST + LLM defense in depth)
FEATURE_BASH_CLASSIFIER=1 FEATURE_TREE_SITTER_BASH=1 bun run dev
```

## 6. File index

| File | Lines | Responsibility |
|------|------|------|
| `src/utils/permissions/bashClassifier.ts` | — | Bash classifier (stub, ANT-ONLY) |
| `src/utils/permissions/yoloClassifier.ts` | 1496 | YOLO classifier (complete reference implementation) |
| `src/utils/classifierApprovals.ts` | — | Classifier approval-signal management |
| `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx` | — | Classifier UI |
| `src/hooks/toolPermission/handlers/interactiveHandler.ts` | — | Interactive permission handling |
| `src/services/api/withRetry.ts` | — | API beta header |
