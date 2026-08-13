import { describe, expect, test } from 'bun:test'
import { DESCRIPTION, PROMPT } from '../prompt.js'

describe('NotebookEdit description (TF-IDF index text)', () => {
  test('names all three edit modes so insert/delete are retrievable', () => {
    // shouldDefer: true → DESCRIPTION is the SearchExtraTools index text. If it
    // only mentioned "replace", a model wanting to insert/delete a cell would
    // never retrieve this tool.
    expect(DESCRIPTION.toLowerCase()).toContain('replace')
    expect(DESCRIPTION.toLowerCase()).toContain('insert')
    expect(DESCRIPTION.toLowerCase()).toContain('delete')
  })
})

describe('NotebookEdit prompt aligns with the shipped schema', () => {
  test('documents cell_id, not the removed cell_number parameter', () => {
    expect(PROMPT).toContain('cell_id')
    expect(PROMPT).not.toContain('cell_number')
  })

  test('covers replace, insert, and delete edit modes', () => {
    expect(PROMPT).toContain('replace')
    expect(PROMPT).toContain('insert')
    expect(PROMPT).toContain('delete')
  })

  test('describes insert as "after the cell with this ID" (matches schema semantics)', () => {
    // The schema says insert goes AFTER the cell with cell_id — not "at the
    // index specified by cell_number".
    expect(PROMPT).toMatch(/after the cell/i)
    expect(PROMPT).not.toContain('0-indexed')
  })
})
