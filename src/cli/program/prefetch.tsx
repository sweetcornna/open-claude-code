// Extracted verbatim from src/main.tsx (S7-4b split).
//
// Background work kicked off once the session is up. `startDeferredPrefetches`
// is re-exported from src/main.tsx because src/interactiveHelpers.tsx imports
// it from there.
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js';
import { getSystemContext, getUserContext } from 'src/context.js';
import { initializeAnalyticsGates } from 'src/services/analytics/sink.js';
import { autoPinSearchCredentials } from 'src/services/search/autoPin.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { prefetchAwsCredentialsAndBedRockInfoIfSafe, prefetchGcpCredentialsIfSafe } from 'src/utils/auth/auth.js';
import { checkHasTrustDialogAccepted } from 'src/utils/config/config.js';
import { getCwd } from 'src/utils/filesystem/cwd.js';
import { logForDiagnosticsNoPII } from 'src/utils/telemetry/diagLogs.js';
import { isBareMode, isEnvTruthy } from 'src/utils/config/envUtils.js';
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js';
import { countFilesRoundedRg } from 'src/utils/filesystem/ripgrep.js';
import { settingsChangeDetector } from 'src/utils/settings/changeDetector.js';
import { skillChangeDetector } from 'src/utils/skills/skillChangeDetector.js';
import { initUser } from 'src/utils/auth/user.js';

/**
 * Prefetch system context (including git status) only when it's safe to do so.
 * Git commands can execute arbitrary code via hooks and config (e.g., core.fsmonitor,
 * diff.external), so we must only run them after trust is established or in
 * non-interactive mode where trust is implicit.
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // In non-interactive mode (--print), trust dialog is skipped and
  // execution is considered trusted (as documented in help text)
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // In interactive mode, only prefetch if trust has already been established
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // Otherwise, don't prefetch - wait for trust to be established first
}

/**
 * Start background prefetches and housekeeping that are NOT needed before first render.
 * These are deferred from setup() to reduce event loop contention and child process
 * spawning during the critical startup path.
 * Call this after the REPL has been rendered.
 */
export function startDeferredPrefetches(): void {
  // This function runs after first render, so it doesn't block the initial paint.
  // However, the spawned processes and async work still contend for CPU and event
  // loop time, which skews startup benchmarks (CPU profiles, time-to-first-render
  // measurements). Skip all of it when we're only measuring startup performance.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
    // --bare: skip ALL prefetches. These are cache-warms for the REPL's
    // first-turn responsiveness (initUser, getUserContext, tips, countFiles,
    // modelCapabilities, change detectors). Scripted -p calls don't have a
    // "user is typing" window to hide this work in — it's pure overhead on
    // the critical path.
    isBareMode()
  ) {
    return;
  }

  // Process-spawning prefetches (consumed at first API call, user is still typing)
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);

  // Analytics and feature flag initialization
  void initializeAnalyticsGates();

  void refreshModelCapabilities();

  // Copy whatever credential each web-search lane is authenticating with into
  // occ's own store, so the next /logout or /provider use does not take web
  // search down to the keyless lane silently (autoPin.ts).
  //
  // This is the first point in startup where BOTH entry paths have applied the
  // full provider env: interactive reaches it through renderAndRun, which runs
  // after showSetupScreens()'s applyConfigEnvironmentVariables(); -p reaches it
  // from rootAction's headless branch, after the same call there. Earlier seams
  // (init(), setup()) run before that, when only the trusted sources' env and
  // the safe allowlist are in place — and running before the DeepSeek/OpenCode
  // mirrors settle is how a mirrored secret gets read as its host key's own.
  void autoPinSearchCredentials();

  // File change detectors deferred from init() to unblock first render
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }

  // Event loop stall detector — logs when the main thread is blocked >500ms
  if (process.env.USER_TYPE === 'ant') {
    void import('src/utils/telemetry/eventLoopStallDetector.js').then(m => m.startEventLoopStallDetector());
  }
}
