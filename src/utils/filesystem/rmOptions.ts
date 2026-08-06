/**
 * Options for recursive deletes.
 *
 * Zero-dependency leaf so any layer can import it.
 */

/**
 * `fs.rm` defaults `maxRetries` to 0, which is fine on POSIX — an unlink there
 * succeeds even while another process holds the file open.
 *
 * Windows is the opposite: a delete fails with EBUSY or ENOTEMPTY whenever
 * *anything* has a handle on a file in the tree, and on a developer machine
 * something usually does — Defender's real-time scanner opens files it has just
 * seen written, editors and indexers hold their own. Plugin install, upgrade
 * and cache eviction all delete trees that were written seconds earlier, so
 * they failed intermittently and for no reason the user could act on.
 *
 * Node provides retries for exactly this; three attempts spaced 100ms covers a
 * scanner finishing with a file, and costs nothing when the first delete works.
 */
export const RM_RECURSIVE = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const
