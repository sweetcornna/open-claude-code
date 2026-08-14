/**
 * `requiredMinimumVersion` / `requiredMaximumVersion` — the managed version gate.
 *
 * An enterprise administrator pins the CLI version range their fleet may run:
 * too old and a known bug or missing policy control is still live; too new and
 * a change has not been vetted yet. When the running build falls outside the
 * range, occ refuses to start and says which way to move.
 *
 * Two deliberate restrictions:
 *
 *  - **Policy settings only.** These keys are a control an admin applies *to*
 *    the user; honouring them from `~/.occ/settings.json` or a repo's
 *    `.occ/settings.json` would let any project the user opens brick their CLI.
 *    The caller passes the policy-source settings, and only those.
 *  - **Fail open on garbage.** A version string that does not parse is ignored
 *    rather than treated as unsatisfied. A typo in a policy file must not lock
 *    an entire fleet out of its tooling.
 *
 * Pure: takes the versions, returns a message or null. No settings read, no
 * process exit, no I/O — so it needs no mocks.
 */

import { gt, lt } from '../text/semver.js'

export type VersionGateInput = {
  /** The running build's version. */
  current: string
  minimum?: string | undefined
  maximum?: string | undefined
}

const SEMVER_SHAPE = /^\d+\.\d+\.\d+/

function isUsableVersion(value: string | undefined): value is string {
  return typeof value === 'string' && SEMVER_SHAPE.test(value.trim())
}

/**
 * @returns the message to print before exiting, or `null` when the running
 * version is allowed (which includes every malformed-input case).
 */
export function evaluateVersionGate(input: VersionGateInput): string | null {
  if (!isUsableVersion(input.current)) return null

  if (isUsableVersion(input.minimum) && lt(input.current, input.minimum)) {
    return (
      `This installation is version ${input.current}, but your organization's managed settings ` +
      `require at least ${input.minimum}. Update before continuing.`
    )
  }

  if (isUsableVersion(input.maximum) && gt(input.current, input.maximum)) {
    return (
      `This installation is version ${input.current}, but your organization's managed settings ` +
      `allow at most ${input.maximum}. Install an approved version before continuing.`
    )
  }

  return null
}
