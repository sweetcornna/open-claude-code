// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
//
// The preAction hook is what turns `occ <subcommand>` into a fully booted CLI:
// it awaits the module-evaluation-time MDM/keychain prefetches, runs init(),
// attaches logging sinks and applies pending config migrations. It deliberately
// does NOT run for `--help`, which is why help output stays cheap.
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { feature } from 'bun:bundle';
import { migrateBypassPermissionsAcceptedToSettings } from 'src/migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateDefaultTierSettingsToDefaultSlot } from 'src/migrations/migrateDefaultTierSettingsToDefaultSlot.js';
import { migrateEnableAllProjectMcpServersToSettings } from 'src/migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateFennecToOpus } from 'src/migrations/migrateFennecToOpus.js';
import { migrateLegacyOpusToCurrent } from 'src/migrations/migrateLegacyOpusToCurrent.js';
import { migrateOpusToOpus1m } from 'src/migrations/migrateOpusToOpus1m.js';
import { migrateSonnet1mToSonnet45 } from 'src/migrations/migrateSonnet1mToSonnet45.js';
import { migrateSonnet45ToSonnet46 } from 'src/migrations/migrateSonnet45ToSonnet46.js';
import { resetAutoModeOptInForDefaultOffer } from 'src/migrations/resetAutoModeOptInForDefaultOffer.js';
import { resetProToOpusDefault } from 'src/migrations/resetProToOpusDefault.js';
import { BIN_NAME } from 'src/constants/brand.js';
import { init } from 'src/entrypoints/init.js';
import { setInlinePlugins } from 'src/bootstrap/state.js';
import { loadPolicyLimits } from 'src/services/policyLimits/index.js';
import { loadRemoteManagedSettings } from 'src/services/remoteManagedSettings/index.js';
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config/config.js';
import { isEnvTruthy } from 'src/utils/config/envUtils.js';
import { clearPluginCache } from 'src/utils/plugins/pluginLoader.js';
import { migrateChangelogFromConfig } from 'src/utils/update/releaseNotes.js';
import { ensureKeychainPrefetchCompleted } from 'src/utils/secureStorage/keychainPrefetch.js';
import { ensureMdmSettingsLoaded } from 'src/utils/settings/mdm/settings.js';
import { profileCheckpoint } from 'src/utils/telemetry/startupProfiler.js';

export function registerPreActionHook(program: CommanderCommand): void {
  // Use preAction hook to run initialization only when executing a command,
  // not when displaying help. This avoids the need for env variable signaling.
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start');
    // Await async subprocess loads started at module evaluation (lines 12-20).
    // Nearly free — subprocesses complete during the ~135ms of imports above.
    // Must resolve before init() which triggers the first settings read
    // (applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → sync keychain reads otherwise ~65ms).
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
    profileCheckpoint('preAction_after_mdm');
    await init();
    profileCheckpoint('preAction_after_init');

    // process.title on Windows sets the console title directly; on POSIX,
    // terminal shell integration may mirror the process name to the tab.
    // After init() so settings.json env can also gate this (gh-4765).
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = BIN_NAME;
    }

    // Attach logging sinks so subcommand handlers can use logEvent/logError.
    // Before PR #11106 logEvent dispatched directly; after, events queue until
    // a sink attaches. setup() attaches sinks for the default command, but
    // subcommands (doctor, mcp, plugin, auth) never call setup() and would
    // silently drop events on process.exit(). Both inits are idempotent.
    const { initSinks } = await import('src/utils/telemetry/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // gh-33508: --plugin-dir is a top-level program option. The default
    // action reads it from its own options destructure, but subcommands
    // (plugin list, plugin install, mcp *) have their own actions and
    // never see it. Wire it up here so getInlinePlugins() works everywhere.
    // thisCommand.opts() is typed {} here because this hook is attached
    // before .option('--plugin-dir', ...) in the chain — extra-typings
    // builds the type as options are added. Narrow with a runtime guard;
    // the collect accumulator + [] default guarantee string[] in practice.
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }

    runMigrations();
    profileCheckpoint('preAction_after_migrations');

    // Load remote managed settings for enterprise customers (non-blocking)
    // Fails open - if fetch fails, continues without remote settings
    // Settings are applied via hot-reload when they arrive
    // Must happen after init() to ensure config reading is allowed
    void loadRemoteManagedSettings();
    void loadPolicyLimits();

    profileCheckpoint('preAction_after_remote_settings');
  });
}

// @[MODEL LAUNCH]: Consider any migrations you may need for model strings. See migrateSonnet1mToSonnet45.ts for an example.
// Bump this when adding a new sync migration so existing users re-run the set.
const CURRENT_MIGRATION_VERSION = 12;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    migrateDefaultTierSettingsToDefaultSlot();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    if (process.env.USER_TYPE === 'ant') {
      migrateFennecToOpus();
    }
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION },
    );
  }
  // Async migration - fire and forget since it's non-blocking
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  });
}
