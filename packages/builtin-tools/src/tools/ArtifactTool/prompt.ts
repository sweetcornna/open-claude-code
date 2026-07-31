export const ARTIFACT_TOOL_NAME = 'artifact'

export async function describeArtifactTool(): Promise<string> {
  return 'Upload an HTML or Markdown file to the configured artifact hosting service and get back a public URL. Markdown files are converted to styled HTML before upload. With the worker backend, pass `hash` to overwrite a previously-uploaded artifact (keeps URL stable).'
}

export async function getArtifactToolPrompt(): Promise<string> {
  return `Upload an HTML or Markdown file to a public hosting service and return a shareable URL plus an internal \`id\` (the "hash").

## Inputs
- \`file_path\` (required): absolute path to a local HTML (\`.html\`/\`.htm\`) or Markdown (\`.md\`/\`.markdown\`) file. Markdown is converted to a styled HTML document before upload — just author plain Markdown (headings, lists, GFM tables, fenced code blocks, blockquotes) and the tool wraps it in a page with a neutral stylesheet.
- \`hash\` (optional, worker backend only): if provided, overwrites the artifact with the same hash (URL stays the same). If omitted, a new random id is generated. The rustypaste backend rejects custom hashes.
- \`ttl\` (optional, default \`7\`): artifact lifetime in days. Must be \`7\` or \`30\`.

## Output
\`{ id, url, expiresAt }\` — \`id\` identifies the uploaded file, \`url\` is publicly accessible, and \`expiresAt\` is empty when the backend does not provide an exact timestamp.

## Workflow
1. Use the Write tool to create a local \`.html\` or \`.md\` file.
2. Call this tool with its \`file_path\`.
3. With the worker backend, pass back the \`id\` returned from the first call as \`hash\` when iterating so the URL stays stable.

## Errors
The tool surfaces backend error codes verbatim (e.g. \`payload_too_large\`, \`unauthorized\`). If the file does not exist, is not a regular file, or has an unsupported extension, the tool returns an \`error\` field without making an HTTP request. Accepted extensions: \`.html\`, \`.htm\`, \`.md\`, \`.markdown\`.`
}
