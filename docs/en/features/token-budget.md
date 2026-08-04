<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/token-budget) · [日本語](/docs/ja/features/token-budget)

# TOKEN_BUDGET — Automatic Token-Budget Continuation Mode

> Feature Flag: `FEATURE_TOKEN_BUDGET=1`
> Implementation status: fully functional

## 1. Overview

TOKEN_BUDGET lets users specify an output-token budget target in a prompt (such as `+500k` or `spend 2M tokens`). Claude then **continues working automatically** until it reaches the target, without requiring the user to press Enter repeatedly to request continuation.

It is intended for long-running tasks that require multiple rounds of tool calls, such as large refactors, batch changes, and large-scale code generation.

## 2. User interaction

### Syntax

| Format | Example | Description |
|------|------|------|
| Shorthand (prefix) | `+500k` | Place it directly at the start of the input |
| Shorthand (suffix) | `Refactor this module +2m` | Append it to the end of the input |
| Full syntax | `spend 2M tokens` or `use 1B tokens` | Embed it in natural language |

Supported units are `k` (thousand), `m` (million), and `b` (billion), case-insensitively.

### UI feedback

- **Input highlighting**: when the input contains budget syntax, the corresponding text is highlighted (`PromptInput.tsx` computes the ranges through `findTokenBudgetPositions`)
- **Spinner progress**: the spinner at the bottom displays real-time progress in formats such as:
  - In progress: `Target: 125,000 / 500,000 (25%) · ~2m 30s`
  - Complete: `Target: 510,000 used (500,000 min ✓)`
  - Includes an ETA calculated from the current token-generation rate

## 3. Implementation architecture

### Data flow

```
User enters "+500k"
     │
     ▼
┌─────────────────────────┐
│  parseTokenBudget()     │  src/utils/tokenBudget.ts
│  regex parse → 500,000  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  REPL.tsx               │  called on submission
│  snapshotOutputTokens   │  snapshotOutputTokensForTurn(500000)
│  ForTurn(500000)        │  records starting token count + budget for the turn
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  query.ts main loop     │  checks after each iteration
│  checkTokenBudget()     │  current output tokens vs budget
└────────┬────────────────┘
         │
    ┌────┴─────┐
    │          │
    ▼          ▼
 continue    stop
 (< 90%)     (≥ 90% or diminishing returns)
    │          │
    ▼          ▼
 inject nudge   normal exit
 and continue   emit completion event
```

### Core modules

#### 1. Parsing layer — `src/utils/tokenBudget.ts`

Three regular expressions parse user input:

```
SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i   // "+500k" at the start
SHORTHAND_END_RE   = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i  // "+2m" at the end
VERBOSE_RE         = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i  // "spend 2M tokens"
```

- `parseTokenBudget(text)` — extracts the budget value and returns `number | null`
- `findTokenBudgetPositions(text)` — returns an array of match positions for input highlighting
- `getBudgetContinuationMessage(pct, turnTokens, budget)` — generates the continuation message

#### 2. State layer — `src/bootstrap/state.ts`

Module-level singleton variables track the current turn's budget state:

```
outputTokensAtTurnStart   — cumulative output-token count at the start of this turn
currentTurnTokenBudget    — budget target for this turn (null means no budget)
budgetContinuationCount   — number of automatic continuations in this turn
```

Key functions:
- `getTotalOutputTokens()` — sums output tokens for all models from `STATE.modelUsage`
- `getTurnOutputTokens()` — `getTotalOutputTokens() - outputTokensAtTurnStart`
- `snapshotOutputTokensForTurn(budget)` — resets the turn baseline and sets a new budget
- `getCurrentTurnTokenBudget()` — returns the current budget

#### 3. Decision layer — `src/query/tokenBudget.ts`

`checkTokenBudget(tracker, agentId, budget, globalTurnTokens)` makes the continue/stop decision:

**Continuation conditions**:
- The call is not running inside a sub-agent (`agentId` is empty)
- A budget exists and is > 0
- The current token count has not reached **90%** of the budget
- Diminishing returns have not been detected (after 3 consecutive nudges, each iteration adds < 500 tokens)

**Stop conditions**:
- The token count reaches 90% of the budget
- Diminishing returns indicate that the model can no longer make substantive progress
- Sub-agent mode bypasses the mechanism entirely

**Diminishing-returns detection**: `continuationCount >= 3` and the deltas from the two most recent nudges are both < 500 tokens.

#### 4. Main-loop integration — `src/query.ts`

```
Inside query():
  1. Create budgetTracker = createBudgetTracker()
  2. Enter the while loop
  3. Call checkTokenBudget() after each iteration
  4. When decision.action === 'continue':
     - Inject a meta user message (nudge)
     - continue at the top of the loop
  5. When decision.action === 'stop':
     - Record a completion event (including the diminishingReturns flag)
     - Return normally
```

#### 5. UI layer

| File | Responsibility |
|------|------|
| `components/PromptInput/PromptInput.tsx:534` | Highlights budget syntax in the input field |
| `components/Spinner.tsx:319-338` | Displays the progress percentage and ETA in the spinner |
| `screens/REPL.tsx:2897` | Parses the budget and takes a snapshot on submission |
| `screens/REPL.tsx:2138` | Clears the budget when the user cancels |
| `screens/REPL.tsx:2963` | Captures budget information at the end of the turn for display |

#### 6. System prompt — `src/constants/prompts.ts:538-551`

Injects a `token_budget` section:

> "When the user specifies a token target (e.g., '+500k', 'spend 2M tokens', 'use 1B tokens'), your output token count will be shown each turn. Keep working until you approach the target — plan your work to fill it productively. The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you."

Note: this prompt is **cached unconditionally** rather than changing with the budget setting, because the phrase "When the user specifies..." makes it a no-op when no budget is present.

#### 7. API attachment — `src/utils/attachments.ts:3830-3845`

Each API call includes an `output_token_usage` attachment:

```json
{
  "type": "output_token_usage",
  "turn": 125000,     // output in this turn
  "session": 350000,  // total output in this session
  "budget": 500000    // budget target
}
```

This lets the model observe its own progress.

## 4. Key design decisions

1. **A 90% threshold rather than 100%**: stop at `COMPLETION_THRESHOLD = 0.9` to prevent the final nudge from generating far more tokens than the budget
2. **Diminishing-returns guard**: after 3 consecutive nudges, if each iteration produces < 500 tokens, treat the model as no longer making substantive progress and stop early
3. **Sub-agent exemption**: do not check budgets inside AgentTool subtasks, which prevents a subtask from triggering another continuation sequence
4. **Unconditionally cached system prompt**: always inject the budget prompt instead of toggling it with budget state, avoiding a roughly 20K-token cache miss whenever the budget state changes
5. **Cancellation clears the budget**: call `snapshotOutputTokensForTurn(null)` when Escape cancels the turn, preventing a stale budget from triggering continuation

## 5. Usage

```bash
# Enable the feature
FEATURE_TOKEN_BUDGET=1 bun run dev

# Use it in a prompt
> +500k Refactor all test files
> spend 2M tokens Migrate this project from JS to TS
> Implement a complete CRUD module +1m
```

## 6. File index

| File | Lines | Responsibility |
|------|------|------|
| `src/utils/tokenBudget.ts` | 73 | Regex parsing + position lookup + continuation-message generation |
| `src/query/tokenBudget.ts` | 93 | Budget tracker + continue/stop decision |
| `src/bootstrap/state.ts:724-743` | 20 | Per-turn token snapshot state |
| `src/constants/prompts.ts:538-551` | 14 | System-prompt injection |
| `src/utils/attachments.ts:3830-3844` | 17 | API attachment injection |
| `src/query.ts:280,1311-1358` | 48 | Main-loop integration |
| `src/screens/REPL.tsx:2897,2963,2138` | 20 | REPL submission/completion/cancellation handling |
| `src/components/Spinner.tsx:319-338` | 20 | Progress UI |
| `src/components/PromptInput/PromptInput.tsx:534` | 1 | Input highlighting |
