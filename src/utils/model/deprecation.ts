/**
 * Model deprecation utilities
 *
 * Contains information about deprecated models and their retirement dates.
 */

import {
  type APIProvider,
  getAPIProvider,
  servesAnthropicModels,
} from './providers.js'

type DeprecatedModelInfo = {
  isDeprecated: true
  modelName: string
  retirementDate: string
  replacementModel?: string
}

type NotDeprecatedInfo = {
  isDeprecated: false
}

type DeprecationInfo = DeprecatedModelInfo | NotDeprecatedInfo

type DeprecationEntry = {
  /** Human-readable model name */
  modelName: string
  /** Retirement dates by provider (null = not deprecated for that provider) */
  retirementDates: Partial<Record<APIProvider, string | null>>
  /** Provider-specific replacement ID (null = provider has no published path). */
  replacementModels: Partial<Record<APIProvider, string | null>>
}

/**
 * Deprecated models and their retirement dates by provider.
 * Keys are substrings to match in model IDs (case-insensitive).
 * To add a new deprecated model, add an entry to this object.
 */
const DEPRECATED_MODELS: Record<string, DeprecationEntry> = {
  'claude-3-opus': {
    modelName: 'Claude 3 Opus',
    retirementDates: {
      firstParty: 'January 5, 2026',
      bedrock: 'January 15, 2026',
      vertex: 'January 5, 2026',
      foundry: 'January 5, 2026',
    },
    replacementModels: {
      // Official 2.1.227 / current Platform docs recommend this newer ID.
      // It intentionally need not be in the local picker table: the warning is
      // migration guidance for a retired explicit ID, not model selection.
      firstParty: 'claude-opus-4-8',
      bedrock: null,
      vertex: null,
      foundry: null,
    },
  },
  'claude-3-7-sonnet': {
    modelName: 'Claude 3.7 Sonnet',
    retirementDates: {
      firstParty: 'February 19, 2026',
      bedrock: 'April 28, 2026',
      vertex: 'May 11, 2026',
      foundry: 'February 19, 2026',
    },
    replacementModels: {
      firstParty: 'claude-sonnet-4-6',
      bedrock: null,
      vertex: null,
      foundry: null,
    },
  },
  'claude-3-5-haiku': {
    modelName: 'Claude 3.5 Haiku',
    retirementDates: {
      firstParty: 'February 19, 2026',
      bedrock: null,
      vertex: null,
      foundry: null,
    },
    replacementModels: {
      firstParty: 'claude-haiku-4-5-20251001',
      bedrock: null,
      vertex: null,
      foundry: null,
    },
  },
}

/**
 * Check if a model is deprecated and get its deprecation info
 */
function getDeprecatedModelInfo(modelId: string): DeprecationInfo {
  if (!servesAnthropicModels()) return { isDeprecated: false }

  const lowercaseModelId = modelId.toLowerCase()
  const provider = getAPIProvider()

  for (const [key, value] of Object.entries(DEPRECATED_MODELS)) {
    const retirementDate = value.retirementDates[provider]
    if (!lowercaseModelId.includes(key) || !retirementDate) continue

    const replacementModel = value.replacementModels[provider]
    return {
      isDeprecated: true,
      modelName: value.modelName,
      retirementDate,
      ...(replacementModel && { replacementModel }),
    }
  }

  return { isDeprecated: false }
}

/**
 * Get a deprecation warning message for a model, or null if not deprecated
 */
export function getModelDeprecationWarning(
  modelId: string | null,
): string | null {
  if (!modelId) {
    return null
  }

  const info = getDeprecatedModelInfo(modelId)
  if (!info.isDeprecated) {
    return null
  }

  const replacement = info.replacementModel
    ? ` Switch to ${info.replacementModel}.`
    : ''
  return `⚠ ${info.modelName} was retired on ${info.retirementDate}.${replacement}`
}
