import { describe, expect, test } from 'bun:test'
import { validateOfficialNameSource } from '../schemas.js'

const RESERVED_NAME = 'claude-plugins-official'

describe('validateOfficialNameSource', () => {
  test('accepts anchored Anthropic GitHub repository forms', () => {
    const sources = [
      { source: 'github', repo: 'anthropics/claude-plugins' },
      {
        source: 'git',
        url: 'https://github.com/anthropics/claude-plugins.git',
      },
      {
        source: 'git',
        url: 'ssh://git@github.com/anthropics/claude-plugins.git',
      },
      {
        source: 'git',
        url: 'git@github.com:anthropics/claude-plugins.git',
      },
    ]

    for (const source of sources) {
      expect(validateOfficialNameSource(RESERVED_NAME, source)).toBeNull()
    }
  })

  test('rejects host, path, credential, and substring confusion', () => {
    const sources = [
      {
        source: 'git',
        url: 'https://evil.example/github.com/anthropics/fake.git',
      },
      {
        source: 'git',
        url: 'https://github.com.evil.example/anthropics/fake.git',
      },
      {
        source: 'git',
        url: 'https://github.com@evil.example/anthropics/fake.git',
      },
      {
        source: 'git',
        url: 'https://token@github.com/anthropics/fake.git',
      },
      {
        source: 'git',
        url: 'http://github.com/anthropics/fake.git',
      },
      {
        source: 'git',
        url: 'ssh://git@evil.example/github.com/anthropics/fake.git',
      },
      {
        source: 'git',
        url: 'evilgit@github.com:anthropics/fake.git',
      },
      { source: 'github', repo: 'anthropics.evil/fake' },
      { source: 'github', repo: 'anthropics/fake/extra' },
    ]

    for (const source of sources) {
      expect(validateOfficialNameSource(RESERVED_NAME, source)).not.toBeNull()
    }
  })

  test('does not constrain non-reserved marketplace names', () => {
    expect(
      validateOfficialNameSource('community-tools', {
        source: 'git',
        url: 'https://evil.example/community-tools.git',
      }),
    ).toBeNull()
  })

  test('requires an exact anthropics owner and repository for github sources', () => {
    for (const repo of [
      'evil/anthropics/repo',
      'anthropics',
      'anthropics/',
      'anthropics/repo/extra',
    ]) {
      expect(
        validateOfficialNameSource(RESERVED_NAME, { source: 'github', repo }),
      ).not.toBeNull()
    }
  })
})
