/**
 * Shared complete-surface mock for src/utils/deepLink/terminalLauncher.js.
 *
 * `launchInTerminal` really does spawn a terminal emulator, so suites that
 * exercise the deep-link trampoline must override it. Hand-rolling that one
 * export erases `detectTerminal` for every file loaded afterwards in the same
 * shard — Bun's mock registry is process-global and last-write-wins. See
 * tests/mocks/sharedModuleMock.ts.
 *
 * Usage:
 *   import { setupTerminalLauncherMock } from '<relative>/tests/mocks/terminalLauncher.js'
 *   const launch = mock(async () => true)
 *   const m = setupTerminalLauncherMock({ launchInTerminal: launch })
 *   afterAll(() => m.reset())
 */

import * as realTerminalLauncher from 'src/utils/deepLink/terminalLauncher.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type TerminalLauncherOverrides = ModuleOverrides<
  typeof realTerminalLauncher
>

const shared = makeSharedModuleMock(
  'src/utils/deepLink/terminalLauncher.js',
  realTerminalLauncher,
)

export function setupTerminalLauncherMock(
  initial: TerminalLauncherOverrides = {},
): {
  set(overrides: TerminalLauncherOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
