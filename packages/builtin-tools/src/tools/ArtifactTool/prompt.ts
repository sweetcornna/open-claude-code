export const ARTIFACT_TOOL_NAME = 'artifact'

export async function describeArtifactTool(): Promise<string> {
  return 'Render a local HTML or Markdown file into a standalone HTML page. By default the page is written into the occ config directory and the returned URL is a local `file://` path — nothing is uploaded and the link is not shareable. Set OCC_ARTIFACTS_BACKEND=worker|rustypaste to publish to a configured host instead.'
}

export async function getArtifactToolPrompt(): Promise<string> {
  return `Render a local HTML or Markdown file into a standalone HTML page and return \`{ id, url, expiresAt }\`.

## Where the page goes
\`OCC_ARTIFACTS_BACKEND\` decides this, not a tool parameter:
- \`local\` (default): writes \`<occ config dir>/artifacts/<id>.html\` and returns a \`file://\` URL. Nothing leaves the machine, so that URL opens only on this user's computer — never present it as a link to share. \`expiresAt\` is empty, \`ttl\` has no effect, and the file is never auto-deleted.
- \`worker\` / \`rustypaste\`: uploads to \`OCC_ARTIFACTS_URL\` and returns a URL anyone holding it can read. Both need \`OCC_ARTIFACTS_TOKEN\`; without it the call fails before any request is made.

## Inputs
Markdown becomes a styled page — responsive, follows the reader's light/dark preference, syntax-highlights fenced code and renders \`mermaid\` fences as diagrams — so author plain Markdown (headings, lists, GFM tables, fenced code, mermaid fences, blockquotes) and let the tool style it. Styling is inline; only the highlighter and mermaid come from a pinned CDN, and the page stays readable without them. An \`.html\` file is stored byte-for-byte and must carry its own styling. Accepted extensions: \`.html\`, \`.htm\`, \`.md\`, \`.markdown\`; 10MB limit.

Pass the \`id\` from an earlier call back as \`hash\` to replace that artifact in place, keeping its URL stable, instead of accumulating copies. \`local\` and \`worker\` support this; \`rustypaste\` rejects it.

## Errors
Returned in the \`error\` field. A missing file, an unsupported extension, and a missing upload token are all reported without any network request; remaining backend error codes (e.g. \`payload_too_large\`) are passed through verbatim.`
}
