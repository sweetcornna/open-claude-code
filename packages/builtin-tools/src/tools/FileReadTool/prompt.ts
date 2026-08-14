/**
 * Read tool prompt text.
 *
 * PURE LEAF — must not import from `src/`, and may only import other tools'
 * `constants.ts`.
 *
 * This module was the single worst offender in the graph: one `isPDFSupported`
 * import chained through utils/model/model.ts -> auth.ts -> the API client ->
 * analytics, so merely reading `FILE_READ_TOOL_NAME` — which 20+ modules do —
 * booted the whole stack. PDF support is now resolved in FileReadTool.ts and
 * handed in as `pdfSupported`.
 *
 * The output feeds the API prompt cache; see the characterization snapshots in
 * tools/__tests__/promptCharacterization.runner.ts.
 */
import { BASH_TOOL_NAME } from '../BashTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/constants.js'
import { MAX_LINES_TO_READ } from './constants.js'

// Compat shims — these now live in the pure constants leaf.
export {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  MAX_LINES_TO_READ,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
} from './constants.js'

export interface ReadPromptParams {
  /** LINE_FORMAT_INSTRUCTION, or whatever line format the caller settled on. */
  lineFormat: string
  /** Trailing clause about the byte cap, or '' when the cap isn't advertised. */
  maxSizeInstruction: string
  /** OFFSET_INSTRUCTION_TARGETED or OFFSET_INSTRUCTION_DEFAULT. */
  offsetInstruction: string
  /**
   * Whether the active model accepts PDF document blocks. Haiku 3 is the only
   * remaining model that predates PDF support; resolving that needs the model
   * registry, which needs auth — hence a param rather than a call.
   */
  pdfSupported: boolean
}

/**
 * Renders the Read tool prompt template. The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(p: ReadPromptParams): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file${p.maxSizeInstruction}
${p.offsetInstruction}
${p.lineFormat}
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.${
    p.pdfSupported
      ? '\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.'
      : ''
  }
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${BASH_TOOL_NAME} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- Do NOT re-read a file you just edited to verify — ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} would have errored if the change failed, and the harness tracks file state for you.`
}
