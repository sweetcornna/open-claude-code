import { describe, expect, test } from 'bun:test'
import { DEFAULT_BUILD_FEATURES, resolveBuildFeatures } from '../defines.ts'

const DEFAULT_FEATURE = DEFAULT_BUILD_FEATURES[0]
const NON_DEFAULT_FEATURE = 'TEST_ONLY_FEATURE'

describe('resolveBuildFeatures', () => {
  test.each(['0', 'false', ''])('%s disables a default feature', value => {
    const features = resolveBuildFeatures({
      [`FEATURE_${DEFAULT_FEATURE}`]: value,
    })

    expect(features.has(DEFAULT_FEATURE)).toBe(false)
  })

  test.each(['1', 'true'])('%s enables a non-default feature', value => {
    const features = resolveBuildFeatures({
      [`FEATURE_${NON_DEFAULT_FEATURE}`]: value,
    })

    expect(features.has(NON_DEFAULT_FEATURE)).toBe(true)
  })

  test.each([
    '0',
    'false',
    '',
    'yes',
  ])('%s does not enable a non-default feature', value => {
    const features = resolveBuildFeatures({
      [`FEATURE_${NON_DEFAULT_FEATURE}`]: value,
    })

    expect(features.has(NON_DEFAULT_FEATURE)).toBe(false)
  })

  test('ignores an empty feature name', () => {
    const features = resolveBuildFeatures({ FEATURE_: '1' })

    expect(features.has('')).toBe(false)
    expect(features).toEqual(new Set(DEFAULT_BUILD_FEATURES))
  })
})
