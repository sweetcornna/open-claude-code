/**
 * Shared, complete mock for `src/utils/task/diskOutput.js`.
 *
 * Several task suites installed 3-4 export partial mocks of this module
 * (getTaskOutputPath / initTaskOutputAsSymlink / evictTaskOutput / ...).
 * Bun's `mock.module` is process-global and last-write-wins, so the surviving
 * partial surface erased the module's other exports — including the
 * `DiskTaskOutput` class — for every file loaded afterwards.
 *
 * makeSharedModuleMock passes class exports through untouched, so
 * `new DiskTaskOutput()` / `instanceof` keep working for suites that need the
 * real thing while this one only overrides the free functions it cares about.
 *
 * Usage:
 *   import { setupTaskDiskOutputMock } from 'tests/mocks/taskDiskOutput.js'
 *   const diskOutputMock = setupTaskDiskOutputMock({ evictTaskOutput: () => {} })
 *   afterAll(() => diskOutputMock.reset())
 */

import * as realDiskOutput from 'src/utils/task/diskOutput.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type TaskDiskOutputOverrides = ModuleOverrides<typeof realDiskOutput>

const shared = makeSharedModuleMock(
  'src/utils/task/diskOutput.js',
  realDiskOutput,
)

export function setupTaskDiskOutputMock(
  initial: TaskDiskOutputOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
