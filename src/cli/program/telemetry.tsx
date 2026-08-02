// Extracted verbatim from src/main.tsx (S7-4b split).
//
// Startup / session telemetry emitters called from the root action.
import { getInitialMainLoopModel, getSdkBetas } from 'src/bootstrap/state.js';
import { isAnalyticsDisabled } from 'src/services/analytics/config.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { isRunningWithBun } from 'src/utils/bundledMode.js';
import { isAutoUpdaterDisabled } from 'src/utils/config.js';
import { getContextWindowForModel } from 'src/utils/context.js';
import { getCwd } from 'src/utils/cwd.js';
import { hasNodeOption } from 'src/utils/envUtils.js';
import { getIsGit, getWorktreeCount } from 'src/utils/git.js';
import { getGhAuthStatus } from 'src/utils/github/ghAuthStatus.js';
import { logError } from 'src/utils/log.js';
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from 'src/utils/model/model.js';
import { getManagedPluginNames } from 'src/utils/plugins/managedPlugins.js';
import { getPluginSeedDirs } from 'src/utils/plugins/pluginDirectories.js';
import { loadAllPluginsCacheOnly } from 'src/utils/plugins/pluginLoader.js';
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import {
  getInitialSettings,
  getManagedSettingsKeysForLogging,
  getSettingsForSource,
} from 'src/utils/settings/settings.js';
import { logPluginLoadErrors, logPluginsEnabledForSession } from 'src/utils/telemetry/pluginTelemetry.js';
import { logSkillsLoaded } from 'src/utils/telemetry/skillLoadedEvent.js';

/**
 * Log managed settings keys to Statsig for analytics.
 * This is called after init() completes to ensure settings are loaded
 * and environment variables are applied before model resolution.
 */
export function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings');
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings);
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(',') as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }
  } catch {
    // Silently ignore errors - this is just for analytics
  }
}

// Check if running in debug/inspection mode
function _isBeingDebugged() {
  const isBun = isRunningWithBun();

  // Check for inspect flags in process arguments (including all variants)
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // Note: Bun has an issue with single-file executables where application arguments
      // from process.argv leak into process.execArgv (similar to https://github.com/oven-sh/bun/issues/11673)
      // This breaks use of --debug mode if we omit this branch
      // We're fine to skip that check, because Bun doesn't support Node.js legacy --debug or --debug-brk flags
      return /--inspect(-brk)?/.test(arg);
    } else {
      // In Node.js, check for both --inspect and legacy --debug flags
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg);
    }
  });

  // Check if NODE_OPTIONS contains inspect flags
  const hasInspectEnv = process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS);

  // Check if inspector is available and active (indicates debugging)
  try {
    // Dynamic import would be better but is async - use global object instead
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector');
    const hasInspectorUrl = !!inspector.url();
    return hasInspectorUrl || hasInspectArg || hasInspectEnv;
  } catch {
    // Ignore error and fall back to argument detection
    return hasInspectArg || hasInspectEnv;
  }
}

/**
 * Per-session skill/plugin telemetry. Called from both the interactive path
 * and the headless -p path (before runHeadless) — both go through
 * main.tsx but branch before the interactive startup path, so it needs two
 * call sites here rather than one here + one in QueryEngine.
 */
export function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(getInitialMainLoopModel() ?? getDefaultMainLoopModel());
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()));
  void loadAllPluginsCacheOnly()
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames();
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs());
      logPluginLoadErrors(errors, managedNames);
    })
    .catch(err => logError(err));
}

function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true;
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true;
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true;
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true;
  }
  return result;
}

export async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return;
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([getIsGit(), getWorktreeCount(), getGhAuthStatus()]);

  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status: ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled: SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry(),
  });
}
