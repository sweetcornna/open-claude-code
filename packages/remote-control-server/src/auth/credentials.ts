import { createHmac, randomBytes } from 'node:crypto'
import { config } from '../config'

type OpaqueTokenKind =
  | 'access'
  | 'refresh'
  | 'browser'
  | 'pair'
  | 'environment'
  | 'work'

const TOKEN_PREFIXES: Record<OpaqueTokenKind, string> = {
  access: 'rca_',
  refresh: 'rcr_',
  browser: 'rcb_',
  pair: 'rcp_',
  environment: 'rce_',
  work: 'rcw_',
}

export function generateOpaqueToken(kind: OpaqueTokenKind): string {
  return `${TOKEN_PREFIXES[kind]}${randomBytes(32).toString('base64url')}`
}

export function digestToken(token: string): string {
  return createHmac('sha256', config.tokenPepper)
    .update(token, 'utf8')
    .digest('hex')
}
