/**
 * Pure configuration rules, kept out of `config.ts` so they can be unit
 * tested. `config.ts` evaluates at import time and is module-mocked by most
 * test files; importing anything from it in a test would hand back the mock.
 */

const PRODUCTION_DATABASE_PATH = '/app/data/rcs.sqlite'

/**
 * Fail fast on production deployments that ship placeholder or reused
 * secrets. `RCS_TOKEN_PEPPER` protects at-rest token digests and
 * `RCS_WORKER_JWT_SECRET` signs worker JWTs: sharing one value across both
 * means a leak of either compromises both, so the two must differ.
 */
export function assertProductionSecrets(
  env: Record<string, string | undefined>,
  isProduction: boolean,
): void {
  if (!isProduction) return
  const pepper = env.RCS_TOKEN_PEPPER
  const secret = env.RCS_WORKER_JWT_SECRET
  if (!pepper || pepper.length < 32) {
    throw new Error(
      'RCS_TOKEN_PEPPER must be at least 32 characters in production',
    )
  }
  if (!secret || secret.length < 32) {
    throw new Error(
      'RCS_WORKER_JWT_SECRET must be at least 32 characters in production',
    )
  }
  if (pepper === secret) {
    throw new Error(
      'RCS_TOKEN_PEPPER and RCS_WORKER_JWT_SECRET must be different values',
    )
  }
}

/**
 * Resolve the SQLite path. The container image mounts `/app/data`, but a
 * developer machine has no `/app` and cannot create one, so defaulting there
 * outside production makes `bun run rcs` die with EROFS before it serves a
 * single request. `:memory:` and any explicit value are passed through.
 */
export function resolveDatabasePath(
  explicitPath: string | undefined,
  isProduction: boolean,
  developmentFallback: string,
): string {
  if (explicitPath) return explicitPath
  return isProduction ? PRODUCTION_DATABASE_PATH : developmentFallback
}
