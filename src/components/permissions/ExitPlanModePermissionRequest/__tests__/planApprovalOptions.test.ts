import { describe, expect, test } from 'bun:test'
import { buildPlanApprovalOptions } from '../planApprovalOptions.js'

const base = {
  showClearContext: false,
  showUltraplan: false,
  usedPercent: null,
  transcriptClassifierEnabled: false,
  onFeedbackChange: () => {},
}

function values(opts: ReturnType<typeof buildPlanApprovalOptions>): string[] {
  return opts.map(o => o.value)
}

describe('buildPlanApprovalOptions — elevated modes are additive', () => {
  test('auto AND bypass available → both options listed (bypass no longer shadowed)', () => {
    const opts = buildPlanApprovalOptions({
      ...base,
      transcriptClassifierEnabled: true,
      isAutoModeAvailable: true,
      isBypassPermissionsModeAvailable: true,
    })
    const v = values(opts)
    expect(v).toContain('yes-resume-auto-mode')
    expect(v).toContain('yes-bypass-keep-context')
    // plain accept-edits fallback only appears when no elevated mode exists
    expect(v).not.toContain('yes-accept-edits-keep-context')
    // auto listed before bypass
    expect(v.indexOf('yes-resume-auto-mode')).toBeLessThan(
      v.indexOf('yes-bypass-keep-context'),
    )
  })

  test('bypass only → bypass option with its explicit value', () => {
    const opts = buildPlanApprovalOptions({
      ...base,
      isAutoModeAvailable: false,
      isBypassPermissionsModeAvailable: true,
    })
    const v = values(opts)
    expect(v).toContain('yes-bypass-keep-context')
    expect(v).not.toContain('yes-resume-auto-mode')
    expect(v).not.toContain('yes-accept-edits-keep-context')
  })

  test('neither elevated mode → auto-accept-edits fallback', () => {
    const opts = buildPlanApprovalOptions({
      ...base,
      isAutoModeAvailable: false,
      isBypassPermissionsModeAvailable: false,
    })
    const v = values(opts)
    expect(v).toContain('yes-accept-edits-keep-context')
    expect(v).not.toContain('yes-bypass-keep-context')
    expect(v).not.toContain('yes-resume-auto-mode')
  })

  test('clear-context slot is additive too', () => {
    const opts = buildPlanApprovalOptions({
      ...base,
      transcriptClassifierEnabled: true,
      showClearContext: true,
      usedPercent: 42,
      isAutoModeAvailable: true,
      isBypassPermissionsModeAvailable: true,
    })
    const v = values(opts)
    expect(v).toContain('yes-auto-clear-context')
    expect(v).toContain('yes-bypass-permissions')
    expect(v).not.toContain('yes-accept-edits')
    const bypassClear = opts.find(o => o.value === 'yes-bypass-permissions')
    expect(bypassClear?.label).toContain('(42% used)')
  })

  test('manual approve and keep-planning are always present, in order', () => {
    const opts = buildPlanApprovalOptions({
      ...base,
      isAutoModeAvailable: false,
      isBypassPermissionsModeAvailable: true,
    })
    const v = values(opts)
    expect(v[v.length - 1]).toBe('no')
    expect(v).toContain('yes-default-keep-context')
  })
})
