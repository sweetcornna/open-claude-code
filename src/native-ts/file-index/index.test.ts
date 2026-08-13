import { describe, expect, test } from 'bun:test'
import { FileIndex } from './index.js'

function paths(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}/directory-${index}/file-${index}.ts`,
  )
}

describe('FileIndex async build generations', () => {
  test('a newer build cancels an older yielding build without mixing storage', async () => {
    const index = new FileIndex()
    const first = index.loadFromFileListAsync(paths('first', 250_000))
    await first.queryable

    const second = index.loadFromFileListAsync(paths('second', 250_000))
    const [firstCompleted, secondCompleted] = await Promise.all([
      first.done,
      second.done,
    ])

    expect(firstCompleted).toBe(false)
    expect(secondCompleted).toBe(true)
    expect(index.search('second', 20)).not.toHaveLength(0)
    expect(index.search('first', 20)).toHaveLength(0)
  })

  test('a synchronous load cancels an older async build', async () => {
    const index = new FileIndex()
    const first = index.loadFromFileListAsync(paths('stale', 250_000))

    index.loadFromFileList(['current/file.ts'])

    expect(await first.done).toBe(false)
    expect(index.search('current', 10).map(result => result.path)).toEqual([
      'current/file.ts',
    ])
  })
})
