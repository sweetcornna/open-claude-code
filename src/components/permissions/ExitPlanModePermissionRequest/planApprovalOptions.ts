// React-free options builder behind ExitPlanModePermissionRequest.tsx, split
// out (FilePermissionDialog/permissionOptions.ts pattern) so the option-set
// logic can be unit-tested without pulling the ink component tree.

import type { OptionWithDescription } from '../../CustomSelect/index.js'

export type ResponseValue =
  | 'yes-bypass-permissions'
  | 'yes-accept-edits'
  | 'yes-accept-edits-keep-context'
  | 'yes-bypass-keep-context'
  | 'yes-default-keep-context'
  | 'yes-resume-auto-mode'
  | 'yes-auto-clear-context'
  | 'ultraplan'
  | 'no'

export function buildPlanApprovalOptions({
  showClearContext,
  showUltraplan,
  usedPercent,
  isAutoModeAvailable,
  isBypassPermissionsModeAvailable,
  transcriptClassifierEnabled,
  onFeedbackChange,
}: {
  showClearContext: boolean
  showUltraplan: boolean
  usedPercent: number | null
  isAutoModeAvailable: boolean | undefined
  isBypassPermissionsModeAvailable: boolean | undefined
  /** feature('TRANSCRIPT_CLASSIFIER') evaluated by the caller (feature() only works in if/ternary position, so the gate travels as data). */
  transcriptClassifierEnabled: boolean
  onFeedbackChange: (v: string) => void
}): OptionWithDescription<ResponseValue>[] {
  const options: OptionWithDescription<ResponseValue>[] = []
  const usedLabel = usedPercent !== null ? ` (${usedPercent}% used)` : ''

  // Elevated modes are ADDITIVE, not either/or: auto mode used to shadow the
  // bypass option entirely, so sessions with auto available had no way to run
  // a plan under bypassPermissions. Order stays auto → bypass; the plain
  // auto-accept-edits fallback only appears when no elevated mode exists.
  const autoAvailable =
    transcriptClassifierEnabled && isAutoModeAvailable === true

  if (showClearContext) {
    if (autoAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and use auto mode`,
        value: 'yes-auto-clear-context',
      })
    }
    if (isBypassPermissionsModeAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and bypass permissions`,
        value: 'yes-bypass-permissions',
      })
    }
    if (!autoAvailable && !isBypassPermissionsModeAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and auto-accept edits`,
        value: 'yes-accept-edits',
      })
    }
  }

  // Keep-context slot, same additive rule.
  if (autoAvailable) {
    options.push({
      label: 'Yes, and use auto mode',
      value: 'yes-resume-auto-mode',
    })
  }
  if (isBypassPermissionsModeAvailable) {
    options.push({
      label: 'Yes, and bypass permissions',
      value: 'yes-bypass-keep-context',
    })
  }
  if (!autoAvailable && !isBypassPermissionsModeAvailable) {
    options.push({
      label: 'Yes, auto-accept edits',
      value: 'yes-accept-edits-keep-context',
    })
  }

  options.push({
    label: 'Yes, manually approve edits',
    value: 'yes-default-keep-context',
  })

  if (showUltraplan) {
    options.push({
      label: 'No, refine with Ultraplan on Claude Code on the web',
      value: 'ultraplan',
    })
  }

  options.push({
    type: 'input',
    label: 'No, keep planning',
    value: 'no',
    placeholder: 'Tell Claude what to change',
    description: 'shift+tab to approve with this feedback',
    onChange: onFeedbackChange,
  })

  return options
}
