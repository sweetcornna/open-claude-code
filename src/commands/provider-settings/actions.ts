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
  renameProfile,
  updateProfileCatalog,
} from 'src/services/providerProfiles/profiles.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { describeNonInteractiveAdd } from './addFlow.js'
import { refreshProfileCatalog } from './catalogRefresh.js'
import { clearProviderFamily, switchProviderFamily } from './providerSwitch.js'
import {
  rehydrateProviderSession,
  type ProviderSessionRehydrateContext,
} from './sessionRehydrate.js'
import {
  buildProviderRows,
  describeAggregatedModels,
  describeAggregateOverview,
  describeCurrentProvider,
  describeProviderRows,
  summarizeAggregate,
  usage,
  type ParsedCommand,
} from './state.js'

/**
 * Current registry rendered as the panel's text equivalent, under the line
 * bare `/provider` used to print on its own. That line is the whole of what
 * the old command answered with no arguments, so the merged command keeps it
 * — here rather than as a separate verb, since "which provider am I on" and
 * "which profiles do I have" are one question in two halves.
 */
function renderRegistry(): string {
  const file = loadProfilesFile()
  return [
    describeCurrentProvider(getAPIProvider(), file.active),
    '',
    describeProviderRows(buildProviderRows(file), buildAggregatedModels(file)),
  ].join('\n')
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
  context?: ProviderSessionRehydrateContext,
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

    case 'overview': {
      const file = loadProfilesFile()
      // Unbounded here: the panel truncates because it has rows to leave room
      // for, and this form has nothing else on the screen.
      return describeAggregateOverview(
        buildProviderRows(file),
        buildAggregatedModels(file),
      ).join('\n')
    }

    case 'add':
      return describeNonInteractiveAdd(loadProfilesFile(), parsed.name)

    case 'set-provider': {
      const result = switchProviderFamily(parsed.provider)
      if (result.switched) rehydrateProviderSession(context)
      return result.message
    }

    case 'unset-provider': {
      const result = clearProviderFamily()
      if (result.switched) rehydrateProviderSession(context)
      return result.message
    }

    case 'rename': {
      const result = renameProfile(parsed.from, parsed.to)
      if ('error' in result) return result.error
      // Only the registry key moved. The live configuration is in settings.env
      // and never carried the name, so an active profile stays active without
      // anything being re-applied.
      return (
        `Renamed "${parsed.from}" to "${parsed.to}".` +
        (result.wasActive ? ' It is still the active profile.' : '')
      )
    }

    case 'use': {
      const result = activateProfile(parsed.name)
      if ('error' in result) return result.error
      rehydrateProviderSession(context)
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
