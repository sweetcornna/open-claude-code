import { describe, expect, test } from 'bun:test'
import {
  getSecretLabel,
  redactSecrets,
  scanForSecrets,
} from '../secretScanner.js'

// Synthetic fixtures shaped to match rule patterns — none are real secrets.
const GH_PAT = `ghp_${'a1B2'.repeat(9)}`
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const NPM_TOKEN = `npm_${'x9Yz'.repeat(9)}`
const SLACK_BOT = 'xoxb-1234567890-1234567890123-AbCdEfGhIjKl'
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEpAIBAAKCAQEA'.repeat(6)}\n-----END RSA PRIVATE KEY-----`

describe('scanForSecrets', () => {
  test('detects representative rules across categories', () => {
    const ids = (content: string) =>
      scanForSecrets(content).map(match => match.ruleId)

    expect(ids(`token=${GH_PAT}`)).toContain('github-pat')
    expect(ids(`aws_access_key_id = ${AWS_KEY}`)).toContain('aws-access-token')
    expect(ids(`//registry.npmjs.org/:_authToken=${NPM_TOKEN} `)).toContain(
      'npm-access-token',
    )
    expect(ids(`SLACK_TOKEN=${SLACK_BOT}`)).toContain('slack-bot-token')
    expect(ids(PRIVATE_KEY)).toContain('private-key')
  })

  test('never returns matched values, deduplicates by rule', () => {
    const matches = scanForSecrets(`${GH_PAT} and again ${GH_PAT}`)
    expect(matches).toHaveLength(1)
    expect(JSON.stringify(matches)).not.toContain(GH_PAT)
  })

  test('ordinary dev content does not fire', () => {
    const content = [
      '# Debugging the login flow',
      'The token refresh happens in auth.ts:1427.',
      'Set ANTHROPIC_API_KEY in your env (never commit it).',
      'const sk = computeSessionKey(user)',
      'sha256: 6dcd4ce23d88e2ee9568ba546c007c63d9131c1b',
    ].join('\n')
    expect(scanForSecrets(content)).toHaveLength(0)
  })

  test('labels are human-readable', () => {
    expect(getSecretLabel('github-pat')).toBe('GitHub PAT')
    expect(getSecretLabel('aws-access-token')).toBe('AWS Access Token')
  })
})

describe('redactSecrets', () => {
  test('replaces only the secret span, preserving boundary characters', () => {
    const input = `token="${NPM_TOKEN}";`
    const output = redactSecrets(input)
    expect(output).toBe('token="[REDACTED]";')
    expect(output).not.toContain(NPM_TOKEN)
  })

  test('redacts every occurrence and leaves surrounding prose intact', () => {
    const input = `first ${GH_PAT} then ${GH_PAT} end`
    const output = redactSecrets(input)
    expect(output).not.toContain(GH_PAT)
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(2)
    expect(output.startsWith('first ')).toBe(true)
    expect(output.endsWith(' end')).toBe(true)
  })

  test('redacted output does not re-trigger the scanner', () => {
    const output = redactSecrets(`key ${AWS_KEY} and ${GH_PAT}`)
    expect(scanForSecrets(output)).toHaveLength(0)
  })

  test('clean content passes through unchanged', () => {
    const content = 'nothing secret here'
    expect(redactSecrets(content)).toBe(content)
  })
})
