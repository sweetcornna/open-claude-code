import { describe, expect, test } from 'bun:test'
import type { EffortValue } from '../../../utils/model/effort.js'
import {
  CANCEL_MESSAGE,
  type ApplyFn,
  ULTRACODE_OFF_MESSAGE,
  ULTRACODE_ON_MESSAGE,
  END_POSITION,
  HOME_POSITION,
  PANEL_POSITIONS,
  type PanelPosition,
  computeConfirmOutcome,
  getInitialCursor,
  isUltracode,
  moveLeft,
  moveRight,
} from '../effortPanelState.js'

describe('effortPanelState', () => {
  test('PANEL_POSITIONS 顺序为 low → ultracode', () => {
    expect(PANEL_POSITIONS).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
  })

  test('moveLeft 在 low 处保持 low', () => {
    expect(moveLeft('low')).toBe('low')
  })

  test('moveLeft 正常左移', () => {
    expect(moveLeft('high')).toBe('medium')
    expect(moveLeft('ultracode')).toBe('max')
  })

  test('moveRight 在 ultracode 处保持 ultracode', () => {
    expect(moveRight('ultracode')).toBe('ultracode')
  })

  test('moveRight 正常右移', () => {
    expect(moveRight('medium')).toBe('high')
    expect(moveRight('max')).toBe('ultracode')
  })

  test('HOME_POSITION 等于 low', () => {
    expect(HOME_POSITION).toBe('low')
  })

  test('END_POSITION 等于 ultracode', () => {
    expect(END_POSITION).toBe('ultracode')
  })

  test('isUltracode 守卫', () => {
    expect(isUltracode('ultracode')).toBe(true)
    expect(isUltracode('max')).toBe(false)
  })

  test('getInitialCursor：env override 为合法档位时返回 env 值', () => {
    expect(
      getInitialCursor({
        envOverride: 'high',
        appStateEffort: 'medium',
        displayed: 'high',
      }),
    ).toBe('high')
  })

  test('getInitialCursor：env 为 null（unset）时用 displayed', () => {
    expect(
      getInitialCursor({
        envOverride: null,
        appStateEffort: undefined,
        displayed: 'medium',
      }),
    ).toBe('medium')
  })

  test('getInitialCursor：env undefined 时用 displayed', () => {
    expect(
      getInitialCursor({
        envOverride: undefined,
        appStateEffort: 'high',
        displayed: 'high',
      }),
    ).toBe('high')
  })

  test('getInitialCursor：env 是数值（ant-only）时落回 displayed', () => {
    // 数值不是合法 PanelPosition，回退
    expect(
      getInitialCursor({
        envOverride: 75,
        appStateEffort: 'medium',
        displayed: 'medium',
      }),
    ).toBe('medium')
  })

  test('PanelPosition 类型编译期检查（隐式）', () => {
    const p: PanelPosition = 'xhigh'
    expect(p).toBe('xhigh')
  })
})

describe('computeConfirmOutcome', () => {
  const mockApply: ApplyFn = cursor => ({
    message: `applied:${cursor}`,
    // 测试里 cursor 是 PanelPosition（含 ultracode），但 ApplyFn 的契约要求 EffortValue。
    // 实际运行时 mockApply 只会被 computeConfirmOutcome 在非 ultracode 档位调用，
    // 因此 cast 是安全的。生产代码用真 executeEffort 不会出现 ultracode。
    effortUpdate: { value: cursor as unknown as EffortValue },
  })

  test('ultracode（当前关闭）→ kind=ultracode-toggle 且 enabled=true', () => {
    const out = computeConfirmOutcome('ultracode', mockApply, false)
    expect(out.kind).toBe('ultracode-toggle')
    if (out.kind === 'ultracode-toggle') {
      expect(out.enabled).toBe(true)
      expect(out.message).toBe(ULTRACODE_ON_MESSAGE)
    }
  })

  test('ultracode（当前开启）→ 再确认即关闭', () => {
    const out = computeConfirmOutcome('ultracode', mockApply, true)
    expect(out.kind).toBe('ultracode-toggle')
    if (out.kind === 'ultracode-toggle') {
      expect(out.enabled).toBe(false)
      expect(out.message).toBe(ULTRACODE_OFF_MESSAGE)
    }
  })

  test('ultracode 不调 applyFn（不会被副作用触发）', () => {
    let called = false
    const spy: ApplyFn = c => {
      called = true
      return { message: `applied:${c}` }
    }
    computeConfirmOutcome('ultracode', spy, false)
    expect(called).toBe(false)
  })

  test('low → kind=apply，message 来自 applyFn，effortUpdate 透传', () => {
    const out = computeConfirmOutcome('low', mockApply, false)
    expect(out.kind).toBe('apply')
    if (out.kind === 'apply') {
      expect(out.message).toBe('applied:low')
      expect(out.effortUpdate?.value).toBe('low')
    }
  })

  test('high → apply 路径不调 ultracode 分支', () => {
    const out = computeConfirmOutcome('high', mockApply, false)
    expect(out.kind).toBe('apply')
  })

  test('applyFn 返回无 effortUpdate 时，outcome.effortUpdate 为 undefined', () => {
    const noUpdate: ApplyFn = c => ({ message: `applied:${c}` })
    const out = computeConfirmOutcome('medium', noUpdate, false)
    expect(out.kind).toBe('apply')
    if (out.kind === 'apply') {
      expect(out.effortUpdate).toBeUndefined()
    }
  })
})

test('常量字符串', () => {
  expect(CANCEL_MESSAGE).toBe('Effort unchanged.')
  expect(ULTRACODE_ON_MESSAGE).toContain('Ultracode ON')
  // `/ultracode` is a knowledge-only skill — it loads the playbook and starts
  // nothing. The old copy promised "/ultracode <context> still starts a
  // one-off workflow", which is a run the command cannot launch.
  expect(ULTRACODE_OFF_MESSAGE).toContain('Ultracode off')
  expect(ULTRACODE_OFF_MESSAGE).toContain('one-off opt-in')
  expect(ULTRACODE_OFF_MESSAGE).not.toContain('starts a one-off workflow')
})
