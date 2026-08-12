import { createHash } from 'node:crypto'
import type { SourceScan } from './types.js'

/** Between fields; never appears in JSON-encoded input. */
const FIELD_SEPARATOR = '\u0000'
/** Between the item list and the unmappable list of one source. */
const SECTION_SEPARATOR = '\u0001'

/**
 * A stable 32-hex fingerprint of an entire scan.
 *
 * This is what binds a `--yes=<digest>` confirm to the exact configuration the
 * user (or the model) was shown. Without it, "scan, show, confirm" is a TOCTOU
 * window: the foreign config could change — or be changed — between the
 * preview and the apply, and the user would be confirming a list they never
 * saw. Re-running the scan and comparing digests closes it.
 *
 * Everything that could differ between two scans is hashed, including each
 * item's `fingerprint` (which covers CONTENT, not just the name), so an edited
 * MCP command or a rewritten prompt invalidates the confirm. Inputs are sorted
 * so the hash does not depend on directory-read order, and every field is JSON
 * encoded and separator-delimited so no combination of labels can be arranged
 * to collide with a different item list.
 */
export function scanDigest(scans: readonly SourceScan[]): string {
  const hash = createHash('sha256')
  for (const scan of [...scans].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  )) {
    hash.update(scan.sourceId).update(FIELD_SEPARATOR)
    for (const item of [...scan.result.items].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      hash
        .update(
          JSON.stringify([
            item.id,
            item.kind,
            item.scope,
            item.label,
            item.description ?? '',
            item.warning ?? '',
            item.note ?? '',
            item.fingerprint,
          ]),
        )
        .update(FIELD_SEPARATOR)
    }
    hash.update(SECTION_SEPARATOR)
    for (const entry of [...scan.result.unmappable].sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.reason.localeCompare(b.reason) ||
        a.scope.localeCompare(b.scope),
    )) {
      hash
        .update(JSON.stringify([entry.scope, entry.label, entry.reason]))
        .update(FIELD_SEPARATOR)
    }
  }
  return hash.digest('hex').slice(0, 32)
}

/** The shape `--yes=<digest>` must have before it is even compared. */
export const SCAN_DIGEST_PATTERN = /^[0-9a-f]{32}$/
