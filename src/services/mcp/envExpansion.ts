/**
 * Shared utilities for expanding environment variables in MCP server configurations
 */

/**
 * Resolves a variable name to its value, or undefined when unset.
 */
export type EnvLookup = (name: string) => string | undefined

const processEnvLookup: EnvLookup = name => process.env[name]

/**
 * Expand environment variables in a string value
 * Handles ${VAR} and ${VAR:-default} syntax
 *
 * @param lookup Resolver for variable names. Defaults to process.env, but
 *   config parsers pass createSettingsAwareEnvLookup() so that expansion does
 *   not depend on whether settings.env has been applied to process.env yet.
 * @returns Object with expanded string and list of missing variables
 */
export function expandEnvVarsInString(
  value: string,
  lookup: EnvLookup = processEnvLookup,
): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
    // Split on :- to support default values (limit to 2 parts to preserve :- in defaults)
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = lookup(varName)

    if (envValue !== undefined) {
      return envValue
    }
    if (defaultValue !== undefined) {
      return defaultValue
    }

    // Track missing variable for error reporting
    missingVars.push(varName)
    // Return original if not found (allows debugging but will be reported as error)
    return match
  })

  return {
    expanded,
    missingVars,
  }
}
