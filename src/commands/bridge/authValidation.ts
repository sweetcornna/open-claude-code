/**
 * Client-side validation for the Remote Control account dialog. Pure and
 * dependency-free so the rules can be tested without an Ink renderer; the
 * server enforces the same bounds, this only avoids a round trip.
 */

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/

export const REMOTE_CONTROL_USERNAME_ERROR =
  'Use 3–32 lowercase letters, numbers, dots, dashes, or underscores.'
export const REMOTE_CONTROL_PASSWORD_ERROR =
  'Password must be between 12 and 128 characters.'

/** Usernames are compared lowercase; callers store the normalized form. */
export function normalizeRemoteControlUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidRemoteControlUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value)
}

export function isValidRemoteControlPassword(value: string): boolean {
  return value.length >= 12 && value.length <= 128
}
