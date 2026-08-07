/**
 * Shared complete-surface mock for src/utils/messages.ts.
 *
 * Bun's mock registry is process-global and last-write-wins, so a hand-written
 * surface here decides what every file loaded later in the shard sees. This
 * wrapper delegates every export to the real module unless the current suite
 * overrides it. See tests/mocks/sharedModuleMock.ts.
 */

// 注意：import 用 .js（TS 的模块解析要求），mock.module 的 specifier 用 .ts
// —— 后者是运行时字符串，且要与全仓其他站点的拼写一致（两者解析到同一个 key）。
import * as realMessages from 'src/utils/messages.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type MessagesOverrides = ModuleOverrides<typeof realMessages>

const shared = makeSharedModuleMock('src/utils/messages.ts', realMessages)

export function setupMessagesMock(initial: MessagesOverrides = {}): {
  set(overrides: MessagesOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
