<!-- lang-switcher -->
**English** · [中文](/docs/zh/telemetry-remote-config-audit) · [日本語](/docs/ja/telemetry-remote-config-audit)

# Telemetry and Remote Configuration Delivery Audit (Excluding Sentry)

> **Since 2.45.0: the first-party paths to `api.anthropic.com` are off by default and require an explicit opt-in.**
> `OCC_ENABLE_1P_TELEMETRY=1` turns on the event export in section 2; `OCC_ENABLE_GROWTHBOOK=1` turns on the
> remote feature-flag fetch in section 3. The two switches are independent and are read from the environment only
> (the `env` block of `settings.json` is the persistent form).
> Upstream ties both paths to "the user has not opted out". For a fork that means shipping a third party's session
> data to Anthropic and letting a remote experiment payload steer local behaviour indefinitely, so occ inverts the
> default.

## 1. Datadog Logging

**File**: `src/services/analytics/datadog.ts`

- **Endpoint**: Configured through the `DATADOG_LOGS_ENDPOINT` environment variable (empty by default, which disables it)
- **Client token**: Configured through the `DATADOG_API_KEY` environment variable (empty by default, which disables it)
- **Behavior**: Sends logs in batches (15s flush interval, maximum 100 entries), only for 1P users (direct Anthropic API connections)
- **Event allowlist**: Events in the `tengu_*` family (~35 types, including startup, errors, OAuth, and tool calls)
- **Baseline data**: Collects model, platform, arch, version, userBucket (users hashed into 30 buckets), and related fields
- **Restricted to**: `NODE_ENV === 'production'`
- **Configuration example**: `DATADOG_LOGS_ENDPOINT=https://http-intake.logs.datadoghq.com/api/v2/logs DATADOG_API_KEY=xxx bun run dev`

## 2. 1P Event Logging (BigQuery)

**File**: `src/services/analytics/firstPartyEventLogger.ts` + `firstPartyEventLoggingExporter.ts`

- **Endpoint**: `https://api.anthropic.com/api/event_logging/batch` (switchable to staging)
- **Switch**: **off by default**; requires `OCC_ENABLE_1P_TELEMETRY=1` (`is1PEventLoggingEnabled()`)
- **Behavior**: Uses the OpenTelemetry SDK's `BatchLogRecordProcessor` to export batches to Anthropic's own BQ pipeline
- **Credential**: Goes through `getFirstPartyTelemetryAuthHeaders()`, not `getAuthHeaders()` — the DeepSeek and OpenCode wires mirror a third-party key into `ANTHROPIC_API_KEY`, and such a value is never sent as `x-api-key` (the POST goes out unauthenticated instead)
- **Data**: Complete event metadata (session, model, environment context, user data, subscription type, and related fields)
- **Resilience**: Persists failed events to local disk (JSONL) and retries with quadratic backoff, up to 8 attempts
- **Proto schema**: Serializes events in the `ClaudeCodeInternalEvent` / `GrowthbookExperimentEvent` protobuf formats
- **Auth fallback**: On a 401 response, automatically removes the auth header and retries

## 3. GrowthBook Remote Feature Flags / Dynamic Configuration

**File**: `src/services/analytics/growthbook.ts`

- **Server**: `https://api.anthropic.com/` (remote eval mode)
- **Switch**: **off by default**; requires `OCC_ENABLE_GROWTHBOOK=1`. A self-hosted adapter (`CLAUDE_GB_ADAPTER_URL` + `CLAUDE_GB_ADAPTER_KEY`) is unaffected
- **Behavior**: Fetches all feature flags at startup, then refreshes them every 6h (external users) / 20min (ant)
- **Disk cache**: **removed**. The remote payload lives in memory only and dies with the process; an existing `cachedGrowthBookFeatures` in `~/.occ.json` is cleared by `/logout` and by `purgeCachedRemoteGates()` at startup
- **Local fallback**: `LOCAL_GATE_DEFAULTS` (`growthbook.ts`) outranks any served value — the last gate for opted-in users and self-hosted adapters
- **Uses**:
  - Controls the Datadog switch (`tengu_log_datadog_events`)
  - Controls event sampling rates (`tengu_event_sampling_config`)
  - Controls the sink kill switch (`tengu_frond_boric`)
  - Controls BQ batch configuration (`tengu_1p_event_batch_config`)
  - Controls the maximum allowed version / automatic-update kill switch
  - Controls the security-check gate for remote managed settings
- **User attributes**: Sends deviceId, sessionId, organizationUUID, accountUUID, email, subscriptionType, and related fields

## 4. Remote Managed Settings (Enterprise Remote Configuration Delivery)

**File**: `src/services/remoteManagedSettings/index.ts`

- **Endpoint**: `{BASE_API_URL}/api/claude_code/settings`
- **Behavior**: Delivers configuration to enterprise users, supports ETag/304 caching, and polls hourly in the background
- **Security**: Prompts the user for confirmation when a change includes “dangerous settings”
- **Applicability**: All API key users can fetch it; OAuth access is limited to Enterprise/C4E/Team users
- **Fail-open**: Uses the local cache if the request fails; skips delivery when no cache exists

## 5. Settings Sync

**File**: `src/services/settingsSync/index.ts`

- **Endpoint**: `{BASE_API_URL}/api/claude_code/user_settings`
- **Behavior**: The CLI uploads local settings/memory to the remote service; CCR mode downloads them from the remote service
- **Synchronized content**: userSettings, userMemory, projectSettings, projectMemory
- **Feature gate**: `UPLOAD_USER_SETTINGS` / `DOWNLOAD_USER_SETTINGS`
- **File size limit**: 500KB/file

## 6. Third-Party OpenTelemetry

**File**: `src/utils/telemetry/instrumentation.ts`

- **Behavior**: Full OTEL SDK initialization supporting all three signal types: metrics / logs / traces
- **Protocol**: gRPC / http-json / http-protobuf (selected through `OTEL_EXPORTER_OTLP_PROTOCOL`)
- **Exporter**: console / otlp / prometheus
- **Trigger**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` environment variable
- **Enhanced trace**: `feature('ENHANCED_TELEMETRY_BETA')` + GrowthBook gate `enhanced_telemetry_beta`

## 7. BigQuery Metrics Exporter (Internal Metrics)

**File**: `src/utils/telemetry/bigqueryExporter.ts`

- **Endpoint**: `https://api.anthropic.com/api/claude_code/metrics`
- **Behavior**: Periodically exports OTel metrics to the internal BQ service (5min interval)
- **Applicability**: API customers and C4E/Team subscribers, and requires `CLAUDE_CODE_ENABLE_TELEMETRY=1`
- **Credential**: Same as section 2 — goes through `getFirstPartyTelemetryAuthHeaders()`
- **Organization-level opt-out**: Queried through the `checkMetricsEnabled()` API (see item 8 below)

## 8. Organization-Level Metrics Opt-out Query

**File**: `src/services/api/metricsOptOut.ts`

- **Endpoint**: `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`
- **Behavior**: Queries whether the organization has enabled metrics, with two-level caching (1h in memory + 24h on disk)
- **Effect**: Controls whether the BigQuery metrics exporter exports data

## 9. Startup Profiling

**File**: `src/utils/startupProfiler.ts`

- **Behavior**: Samples startup performance data (100% for ant / 0.5% for external users) and reports it through `logEvent('tengu_startup_perf')`
- **Detailed mode**: `CLAUDE_CODE_PROFILE_STARTUP=1` writes a complete performance report to a file

## 10. Beta Session Tracing

**File**: `src/utils/telemetry/betaSessionTracing.ts`

- **Behavior**: Produces a detailed debug trace containing the system prompt, model output, tool schema, and related data
- **Trigger**: `ENABLE_BETA_TRACING_DETAILED=1` + `BETA_TRACING_ENDPOINT`
- **External users**: Enabled automatically in SDK/headless mode; interactive mode requires the GrowthBook gate `tengu_trace_lantern`

## 11. Bridge Poll Config (Remote Polling Interval Configuration)

**File**: `src/bridge/pollConfig.ts`

- **Behavior**: Fetches bridge polling interval configuration from GrowthBook (`tengu_bridge_poll_interval_config`)
- **Controls**: The various poll intervals for single-session and multi-session operation

## 12. Plugin/MCP Telemetry

**File**: `src/utils/plugins/fetchTelemetry.ts`

- **Behavior**: Records plugin/marketplace network requests (installation counts, marketplace clone/pull operations, and related requests)
- **Event**: `tengu_plugin_remote_fetch`, including host (redacted), outcome, and duration

---

## Switch Reference

```bash
# The first-party paths are off by default; these two are the only way to turn
# them on, and they are independent of each other.
OCC_ENABLE_1P_TELEMETRY=1   # section 2: event export to api.anthropic.com
OCC_ENABLE_GROWTHBOOK=1     # section 3: remote feature-flag fetch
```

Opt-outs outrank opt-ins: set any of the following and the two switches above have no effect.

```bash
# Disable all telemetry (Datadog + 1P + surveys)
DISABLE_TELEMETRY=1

# More aggressive: disable all nonessential network traffic (including automatic updates, grove, release notes, and related traffic)
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Automatically disabled for 3P providers
CLAUDE_CODE_USE_BEDROCK=1  # or VERTEX/FOUNDRY
```

`src/utils/privacyLevel.ts` is the centralized control point and defines three levels: `default < no-telemetry < essential-traffic`.

---

## Data-Flow Architecture

```
User action → logEvent()
                  ↓
             sink.ts (routing layer)
               ↙        ↘
       trackDatadogEvent()   logEventTo1P()
              ↓                      ↓
       Datadog HTTP API     OTel BatchLogRecordProcessor
       (us5.datadoghq.com)       ↓
                        FirstPartyEventLoggingExporter
                                 ↓
                        api.anthropic.com/api/event_logging/batch
                                 ↓
                        BigQuery (ClaudeCodeInternalEvent proto)
```

GrowthBook operates as an independent channel and also controls the switches and configuration for both sinks above. In the default state neither path starts: `logEventTo1P()` returns at the `is1PEventLoggingEnabled()` check, and the GrowthBook client is never constructed.
