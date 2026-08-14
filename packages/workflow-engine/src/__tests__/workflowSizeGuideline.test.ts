import { describe, expect, test } from 'bun:test'
import { workflowSizeGuidelineSection } from '../tool/WorkflowTool.js'

describe('workflowSizeGuidelineSection', () => {
  test('emits nothing when unset — the default prompt stays byte-identical', () => {
    expect(workflowSizeGuidelineSection(undefined)).toBe('')
  })

  test('emits nothing for "unrestricted"', () => {
    expect(workflowSizeGuidelineSection('unrestricted')).toBe('')
  })

  test('names the tier and its agent ceiling', () => {
    expect(workflowSizeGuidelineSection('small')).toContain(
      'small — keep workflows under 5 agents',
    )
    expect(workflowSizeGuidelineSection('medium')).toContain(
      'medium — keep workflows under 15 agents',
    )
    expect(workflowSizeGuidelineSection('large')).toContain(
      'large — keep workflows under 50 agents',
    )
  })

  test('says it is advisory, so a wider fan-out the user asked for is not blocked', () => {
    expect(workflowSizeGuidelineSection('medium')).toContain(
      'This is a guideline, not a hard limit',
    )
  })

  test('is appended as its own paragraph', () => {
    expect(workflowSizeGuidelineSection('large').startsWith('\n\n')).toBe(true)
  })
})
