/**
 * The side-effectful half of /provider-settings: one function that executes a
 * ParsedCommand against the registry and answers with text.
 *
 * Both entry points go through here — the panel's non-interactive argument
 * form AND `/provider`'s long-standing `save|use|list|delete` subcommands — so
 * the two can never drift into doing different things to the same registry.
 *
 * Switching is `activateProfile()` and nothing else. That function owns the
 * whole-shape settings.env write plus the client-cache clear, and a second
 * copy of that sequence is the single easiest way to leave a previous
 * provider's endpoint pointed at a new provider's key.
 */

import { buildAggregatedModels } from 'src/services/providerProfiles/aggregate.js'
import {
  activateProfile,
  deleteProfile,
  saveCurrentAsProfile,
} from 'src/services/providerProfiles/activate.js'
import {
  loadProfilesFile,
  updateProfileCatalog,
} from 'src/services/providerProfiles/profiles.js'
import { refreshProfileCatalog } from './catalogRefresh.js'
import {
  buildProviderRows,
  describeAggregatedModels,
  describeProviderRows,
  summarizeAggregate,
  usage,
  type ParsedCommand,
} from './state.js'

/** Current registry rendered as the panel's text equivalent. */
function renderRegistry(): string {
  const file = loadProfilesFile()
  return describeProviderRows(
    buildProviderRows(file),
    buildAggregatedModels(file),
  )
}

/**
 * Run one parsed command. Never throws; every failure comes back as text the
 * caller can print verbatim.
 *
 * `panel` is answered with the same listing the panel shows, so a caller with
 * no way to render Ink (a `-p` run, `/provider` with no subcommand) still gets
 * the useful half rather than an error about interactivity.
 */
export async function runProviderSettingsCommand(
  parsed: ParsedCommand,
): Promise<string> {
  switch (parsed.kind) {
    case 'help':
      return usage()

    case 'error':
      return parsed.message

    case 'panel':
    case 'list':
      return renderRegistry()

    case 'models':
      return describeAggregatedModels(buildAggregatedModels(loadProfilesFile()))

    case 'use': {
      const result = activateProfile(parsed.name)
      if ('error' in result) return result.error
      return (
        `Activated profile "${parsed.name}" → provider ` +
        `${result.profile.modelType}.`
      )
    }

    case 'save': {
      const result = saveCurrentAsProfile({
        name: parsed.name,
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      })
      if ('error' in result) return result.error
      return (
        `Saved profile "${parsed.name}" (${result.profile.modelType}). ` +
        `Add its models to the aggregated list with: ` +
        `/provider-settings aggregate ${parsed.name} on`
      )
    }

    case 'delete': {
      const result = deleteProfile(parsed.name)
      if ('error' in result) return result.error
      return `Deleted profile "${parsed.name}".`
    }

    case 'aggregate': {
      const result = updateProfileCatalog(parsed.name, {
        aggregate: parsed.enabled,
      })
      if ('error' in result) return result.error
      const file = loadProfilesFile()
      const summary = summarizeAggregate(
        buildProviderRows(file),
        buildAggregatedModels(file),
      )
      const state = parsed.enabled ? 'joins' : 'no longer joins'
      // Opting in a profile that has never been refreshed is legal and silent
      // otherwise — it just contributes nothing, which reads as a broken
      // toggle rather than a missing snapshot.
      const hint =
        parsed.enabled && (result.profile.models?.length ?? 0) === 0
          ? `\nIt has no model snapshot yet — run: /provider-settings refresh ${parsed.name}`
          : ''
      return `"${parsed.name}" ${state} the aggregated model list.\n${summary}${hint}`
    }

    case 'refresh': {
      const result = await refreshProfileCatalog(parsed.name)
      if ('error' in result) return result.error
      const file = loadProfilesFile()
      const aggregating = file.profiles[parsed.name]?.aggregate === true
      const hint = aggregating
        ? ''
        : `\nIt is not in the aggregated list — add it with: /provider-settings aggregate ${parsed.name} on`
      return `Read ${result.models.length} models for "${parsed.name}".${hint}`
    }
  }
}
