/**
 * The Read prompt is a pure leaf, so it can be exercised directly — no mocks,
 * no module graph. Before the leaf extraction this file would have booted
 * auth and the API client, because `isPDFSupported()` was resolved inside the
 * template.
 */
import { describe, expect, test } from 'bun:test'
import {
  LINE_FORMAT_INSTRUCTION,
  MAX_LINES_TO_READ,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
} from '../constants.js'
import { renderPromptTemplate } from '../prompt.js'

const base = {
  lineFormat: LINE_FORMAT_INSTRUCTION,
  maxSizeInstruction: '',
  offsetInstruction: OFFSET_INSTRUCTION_DEFAULT,
  pdfSupported: true,
}

describe('renderPromptTemplate', () => {
  test('advertises PDF reading when the model supports document blocks', () => {
    expect(renderPromptTemplate(base)).toContain('This tool can read PDF files')
  })

  test('omits the PDF bullet entirely when the model predates PDF support', () => {
    const prompt = renderPromptTemplate({ ...base, pdfSupported: false })
    expect(prompt).not.toContain('PDF')
    // The surrounding bullets must still be adjacent — no blank line left behind.
    expect(prompt).toContain(
      'multimodal LLM.\n- This tool can read Jupyter notebooks',
    )
  })

  test('inlines the caller-supplied offset and size instructions', () => {
    const prompt = renderPromptTemplate({
      ...base,
      maxSizeInstruction: '. Files larger than 256KB will return an error',
      offsetInstruction: OFFSET_INSTRUCTION_TARGETED,
    })
    expect(prompt).toContain(
      `it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file. Files larger than 256KB will return an error`,
    )
    expect(prompt).toContain(OFFSET_INSTRUCTION_TARGETED)
    expect(prompt).not.toContain(OFFSET_INSTRUCTION_DEFAULT)
  })

  test('points at the Bash tool for directory listings', () => {
    expect(renderPromptTemplate(base)).toContain(
      'use an ls command via the Bash tool',
    )
  })
})
