import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'

// NOTE: NotebookEdit has `shouldDefer: true`, so DESCRIPTION is the text fed to
// the SearchExtraTools TF-IDF index. It must name all three edit modes, or a
// model looking to insert/delete a cell will never retrieve this tool.
export const DESCRIPTION =
  'Edit a cell in a Jupyter notebook — replace, insert, or delete.'

// The prompt describes the schema this tool actually ships (`cell_id`), not the
// pre-`cell_id` `cell_number` API. `cell_id` is an opaque cell identifier, and
// insert semantics are "after the cell with this ID" — not "at an index".
export const PROMPT = `Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file). Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing.

Usage:
- You must use the ${FILE_READ_TOOL_NAME} tool on the notebook in this conversation before editing — this tool will fail otherwise.
- \`notebook_path\` must be an absolute path.
- \`cell_id\` is the \`id\` of the cell to edit. It is required for \`replace\` and \`delete\`.
- \`edit_mode\` defaults to \`replace\`. Use \`insert\` to add a new cell after the cell with the given \`cell_id\` (or at the beginning of the notebook if \`cell_id\` is omitted) — \`cell_type\` is required when inserting. Use \`delete\` to remove the cell with the given \`cell_id\`.`
