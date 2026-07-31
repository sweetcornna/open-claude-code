/**
 * Remote settings sync is disabled until occ has its own backend namespace.
 * Anthropic's endpoint belongs to the official product and must not be used as
 * either a source or destination for occ configuration.
 */
export function uploadUserSettingsInBackground(): Promise<void> {
  return Promise.resolve()
}

export function downloadUserSettings(): Promise<boolean> {
  return Promise.resolve(false)
}

export function redownloadUserSettings(): Promise<boolean> {
  return Promise.resolve(false)
}

/** Test-only compatibility hook retained for existing callers. */
export function _resetDownloadPromiseForTesting(): void {}
