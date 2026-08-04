<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/ultraplan) · [日本語](/docs/ja/features/ultraplan)

# ULTRAPLAN — Enhanced Planning

> Feature Flag: `FEATURE_ULTRAPLAN=1`
> Implementation status: Keyword detection is complete, command handling is complete, and CCR remote sessions are complete
> References: 10

## 1. Feature overview

ULTRAPLAN automatically enters enhanced planning mode when it detects the "ultraplan" keyword in user input. Compared with standard plan mode, ultraplan provides deeper planning capabilities and supports both local and remote (CCR) execution.

### Trigger methods

| Method | Behavior |
|------|------|
| Text containing "ultraplan" | Automatically redirects to the `/ultraplan` command |
| `/ultraplan` slash command | Executes directly |
| Rainbow highlighting | Applies a rainbow animation to the "ultraplan" keyword in the input field |

## 2. Implementation architecture

### 2.1 Module status

| Module | File | Lines | Status |
|------|------|------|------|
| Command handler | `src/commands/ultraplan.tsx` | 525 | **Complete** |
| CCR session | `src/utils/ultraplan/ccrSession.ts` | 349 | **Complete** |
| Keyword detection | `src/utils/ultraplan/keyword.ts` | 127 | **Complete** |
| Embedded prompt | `src/utils/ultraplan/prompt.txt` | 1 | **Complete** |
| REPL dialogs | `src/screens/REPL.tsx` | — | **Wired** |
| Keyword highlighting | `src/components/PromptInput/PromptInput.tsx` | — | **Wired** |

### 2.2 Keyword detection

File: `src/utils/ultraplan/keyword.ts` (127 lines)

`findUltraplanTriggerPositions(text)` applies contextual filtering:
- Excludes "ultraplan" inside quotation marks
- Excludes "ultraplan" in paths such as `/path/to/ultraplan/`
- Excludes contexts other than slash commands
- `replaceUltraplanKeyword(text)` removes the keyword

### 2.3 CCR remote sessions

File: `src/utils/ultraplan/ccrSession.ts` (349 lines)

The `ExitPlanModeScanner` class implements a complete event state machine:
- `pollForApprovedExitPlanMode()` — 3-second polling interval
- Timeout handling and retries
- Support for remote (teleport) and local execution

### 2.4 Data flow

```
User enters "help me ultraplan this module refactor"
         │
         ▼
processUserInput detects "ultraplan"
         │
         ▼
Redirect to the /ultraplan command
         │
         ├── Local execution → EnterPlanMode
         │
         └── Remote execution → teleportToRemote → CCR session
                │
                ▼
         ExitPlanModeScanner polls
                │
                ▼
         User approves remotely → result arrives locally
```

## 3. Incomplete content

| Module | Description |
|------|------|
| UltraplanChoiceDialog / UltraplanLaunchDialog in `src/screens/REPL.tsx` | Dialog components in which the user chooses local or remote execution |
| `src/commands/ultraplan/` | Empty directory, possibly an unmerged subcommand structure |

## 4. Key design decisions

1. **Context-aware keyword filtering**: Exclude "ultraplan" in quotation marks and paths to prevent accidental activation.
2. **Local and remote modes**: Support both local plan mode and remote CCR sessions.
3. **Rainbow highlighting feedback**: Apply a rainbow animation to the "ultraplan" keyword in the input field to indicate that it is a special feature.
4. **processUserInput integration**: Intercept the keyword in the user-input processing pipeline and redirect seamlessly.

## 5. Usage

```bash
# Enable the feature
FEATURE_ULTRAPLAN=1 bun run dev

# Use it in the REPL
# > ultraplan refactor the authentication module
# > /ultraplan
```

## 6. File index

| File | Lines | Responsibility |
|------|------|------|
| `src/commands/ultraplan.tsx` | 525 | Slash-command handler |
| `src/utils/ultraplan/ccrSession.ts` | 349 | CCR remote-session management |
| `src/utils/ultraplan/keyword.ts` | 127 | Keyword detection and replacement |
| `src/utils/ultraplan/prompt.txt` | 1 | Embedded prompt |
| `src/utils/processUserInput/processUserInput.ts:468` | — | Keyword redirection |
| `src/components/PromptInput/PromptInput.tsx` | — | Rainbow highlighting |
