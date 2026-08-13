import type { ToolUseContext } from '../../Tool.js'
import type { Message } from 'src/types/message.js'
import {
  getSdkBetas,
  getTotalCostUSD,
  getTotalOutputTokens,
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
} from '../../bootstrap/state.js'
import { getContextWindowForModel } from '../session/context.js'
import {
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from '../session/tokens.js'
import {
  type AutoCompactContext,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isHumanTurn } from '../session/messagePredicates.js'
import { isEnvTruthy } from '../config/envUtils.js'
import { feature } from 'bun:bundle'
import { VERIFY_PLAN_REMINDER_CONFIG } from './config.js'
import type { Attachment } from './types.js'

export function getTokenUsageAttachment(
  messages: Message[],
  model: string,
  compactContext: AutoCompactContext = {},
): Attachment[] {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return []
  }

  const contextWindow = getEffectiveContextWindowSize(model, compactContext)
  const usedTokens = tokenCountFromLastAPIResponse(messages)

  return [
    {
      type: 'token_usage',
      used: usedTokens,
      total: contextWindow,
      remaining: contextWindow - usedTokens,
    },
  ]
}

export function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget === null || budget <= 0) {
      return []
    }
    return [
      {
        type: 'output_token_usage',
        turn: getTurnOutputTokens(),
        session: getTotalOutputTokens(),
        budget,
      },
    ]
  }
  return []
}

export function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }

  const usedCost = getTotalCostUSD()
  const remainingBudget = maxBudgetUsd - usedCost

  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}

/**
 * Count human turns since plan mode exit (plan_mode_exit attachment).
 * Returns 0 if no plan_mode_exit attachment found.
 *
 * tool_result messages are type:'user' without isMeta, so filter by
 * toolUseResult to avoid counting them — otherwise the 10-turn reminder
 * interval fires every ~10 tool calls instead of ~10 human turns.
 */
export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    // Stop counting at plan_mode_exit attachment (marks when implementation started)
    if (
      message?.type === 'attachment' &&
      message.attachment!.type === 'plan_mode_exit'
    ) {
      return turnCount
    }
  }
  // No plan_mode_exit found
  return 0
}

/**
 * Get verify plan reminder attachment if the model hasn't called VerifyPlanExecution yet.
 */
export async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // Only remind if plan exists and verification not started or completed
  if (
    !pending ||
    pending.verificationStarted ||
    pending.verificationCompleted
  ) {
    return []
  }

  // Only remind every N turns
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (
      turnCount === 0 ||
      turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
    ) {
      return []
    }
  }

  return [{ type: 'verify_plan_reminder' }]
}

export function getCompactionReminderAttachment(
  messages: Message[],
  model: string,
  compactContext: AutoCompactContext = {},
): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_fox', false)) {
    return []
  }

  if (!isAutoCompactEnabled()) {
    return []
  }

  const contextWindow = getContextWindowForModel(
    model,
    getSdkBetas(),
    compactContext.settingsSlot,
    compactContext.sessionOverrides,
  )
  if (contextWindow < 1_000_000) {
    return []
  }

  const effectiveWindow = getEffectiveContextWindowSize(model, compactContext)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []
  }

  return [{ type: 'compaction_reminder' }]
}
