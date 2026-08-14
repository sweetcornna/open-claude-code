/**
 * `"defaultMode": "manual"` must survive settings validation.
 *
 * Why this matters more than it looks: occ skips the ENTIRE settings file when
 * validation fails (InvalidSettingsDialog says so out loud), so one unknown
 * enum member copied over from an official Claude Code install silently drops
 * every other setting in that file. 'manual' is upstream's input-surface
 * spelling for 'default'.
 *
 * No mocks: the schema and the alias table are pure.
 */
import { describe, expect, test } from 'bun:test'
import { toJSONSchema } from 'zod/v4'
import {
  PERMISSION_MODE_INPUTS,
  normalizePermissionModeAlias,
  parsePermissionMode,
} from '../../../types/permissions.js'
import { PermissionsSchema, SettingsSchema } from '../types.js'

describe('normalizePermissionModeAlias', () => {
  test('maps manual to default and leaves everything else alone', () => {
    expect(normalizePermissionModeAlias('manual')).toBe('default')
    expect(normalizePermissionModeAlias('plan')).toBe('plan')
    expect(normalizePermissionModeAlias('nonsense')).toBe('nonsense')
  })

  test('parsePermissionMode rejects unknown values', () => {
    expect(parsePermissionMode('manual')).toBe('default')
    expect(parsePermissionMode('auto')).toBe('auto')
    expect(parsePermissionMode('nonsense')).toBeUndefined()
  })

  test('the accepted input set is the real modes plus the aliases', () => {
    expect([...PERMISSION_MODE_INPUTS]).toEqual([
      'acceptEdits',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
      'auto',
      'manual',
    ])
  })
})

describe('settings permissions.defaultMode', () => {
  test('accepts "manual" and stores it as "default"', () => {
    const parsed = PermissionsSchema().safeParse({ defaultMode: 'manual' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.defaultMode).toBe('default')
  })

  test('a whole settings file with defaultMode: manual still validates', () => {
    // The regression: one bad enum member used to reject the file, taking the
    // unrelated keys with it.
    const parsed = SettingsSchema().safeParse({
      permissions: { defaultMode: 'manual' },
      cleanupPeriodDays: 7,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.permissions?.defaultMode).toBe(
      'default',
    )
    expect(parsed.success && parsed.data.cleanupPeriodDays).toBe(7)
  })

  test('real modes are untouched and nonsense is still rejected', () => {
    expect(PermissionsSchema().safeParse({ defaultMode: 'plan' }).success).toBe(
      true,
    )
    expect(PermissionsSchema().safeParse({ defaultMode: 'yolo' }).success).toBe(
      false,
    )
  })

  test('the published JSON schema still lists the modes', () => {
    // `.overwrite()` rather than `.transform()` precisely so this stays an
    // enum: a transform renders as `{}` and editors lose completion.
    const jsonSchema = toJSONSchema(PermissionsSchema(), {
      unrepresentable: 'any',
    }) as {
      properties?: { defaultMode?: { enum?: string[] } }
    }
    expect(jsonSchema.properties?.defaultMode?.enum).toEqual([
      ...PERMISSION_MODE_INPUTS,
    ])
  })
})
