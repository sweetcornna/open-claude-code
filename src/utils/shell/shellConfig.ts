/**
 * Utilities for managing shell configuration files (like .bashrc, .zshrc)
 * Used for managing occ aliases and PATH entries
 */

import { open, readFile } from 'fs/promises'
import { homedir as osHomedir } from 'os'
import { join } from 'path'
import { BIN_NAME } from 'src/constants/brand.js'
import { occConfigPath } from 'src/config/paths.js'
import { isFsInaccessible } from '../runtime/errors.js'

export const OCC_ALIAS_REGEX = new RegExp(`^\\s*alias\\s+${BIN_NAME}\\s*=`)
const QUOTED_OCC_ALIAS_REGEX = new RegExp(
  `alias\\s+${BIN_NAME}\\s*=\\s*["']([^"']+)["']`,
)
const UNQUOTED_OCC_ALIAS_REGEX = new RegExp(
  `alias\\s+${BIN_NAME}\\s*=\\s*([^#\\n]+)`,
)
type EnvLike = Record<string, string | undefined>

type ShellConfigOptions = {
  env?: EnvLike
  homedir?: string
}

/**
 * Get the paths to shell configuration files
 * Respects ZDOTDIR for zsh users
 * @param options Optional overrides for testing (env, homedir)
 */
export function getShellConfigPaths(
  options?: ShellConfigOptions,
): Record<string, string> {
  const home = options?.homedir ?? osHomedir()
  const env = options?.env ?? process.env
  const zshConfigDir = env.ZDOTDIR || home
  return {
    zsh: join(zshConfigDir, '.zshrc'),
    bash: join(home, '.bashrc'),
    fish: join(home, '.config/fish/config.fish'),
  }
}

/**
 * Filter out installer-created occ aliases from an array of lines.
 * Only removes aliases pointing to the current occ local install path.
 * Preserves custom user aliases that point to other locations.
 * Returns the filtered lines and whether our default installer alias was found
 */
export function filterOccAliases(lines: string[]): {
  filtered: string[]
  hadAlias: boolean
} {
  let hadAlias = false
  const filtered = lines.filter(line => {
    if (OCC_ALIAS_REGEX.test(line)) {
      let match = line.match(QUOTED_OCC_ALIAS_REGEX)
      if (!match) {
        match = line.match(UNQUOTED_OCC_ALIAS_REGEX)
      }

      if (match && match[1]) {
        const target = match[1].trim()
        // Only remove if it points to the installer location
        // The installer always creates aliases with the full expanded path
        if (target === occConfigPath('local', BIN_NAME)) {
          hadAlias = true
          return false // Remove this line
        }
      }
      // Keep custom aliases that don't point to the installer location
    }
    return true
  })
  return { filtered, hadAlias }
}

/**
 * Read a file and split it into lines
 * Returns null if file doesn't exist or can't be read
 */
export async function readFileLines(
  filePath: string,
): Promise<string[] | null> {
  try {
    const content = await readFile(filePath, { encoding: 'utf8' })
    return content.split('\n')
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * Write lines back to a file
 */
export async function writeFileLines(
  filePath: string,
  lines: string[],
): Promise<void> {
  const fh = await open(filePath, 'w')
  try {
    await fh.writeFile(lines.join('\n'), { encoding: 'utf8' })
    await fh.datasync()
  } finally {
    await fh.close()
  }
}
