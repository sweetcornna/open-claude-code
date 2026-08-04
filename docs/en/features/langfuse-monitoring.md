<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/langfuse-monitoring) · [日本語](/docs/ja/features/langfuse-monitoring)

# Langfuse Monitoring Integration

> Implementation status: Complete; enabled through environment variables
> Dependencies: `@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/sdk-trace-base`

## 1. Feature overview

Langfuse is an open-source LLM observability platform for tracing, monitoring, and debugging request flows in AI applications. occ integrates Langfuse into the query flow through an OpenTelemetry (OTel) bridge to provide:

- **LLM-call tracing** — records the model, provider, input/output, and token usage for every API request
- **Tool-execution tracing** — records the name, input, output, duration, and errors of every tool call
- **Multi-agent tracing** — gives the main agent and each subagent independent trace chains
- **Data sanitization** — automatically masks sensitive information such as API keys, file contents, and shell output

## 2. Enabling the integration

Langfuse is open source. You can **self-host** it with Docker or Kubernetes, or use the official **[Langfuse Cloud](https://cloud.langfuse.com)** service for free testing. After registration, obtain keys from Project Settings → API Keys.

Only three environment variables are required:

| Environment variable | Description |
|---------|------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (required) |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (required) |
| `LANGFUSE_BASE_URL` | Service URL; defaults to `https://cloud.langfuse.com`; set it to your own URL when self-hosting (required) |

When these variables are not configured, every tracing function is a no-op with zero overhead.

### Configure through settings.json (recommended)

Add the variables to the `env` field in `.occ/settings.json` so they take effect automatically on every launch:

```json
{
  "env": {
    "LANGFUSE_PUBLIC_KEY": "pk-xxx",
    "LANGFUSE_SECRET_KEY": "sk-xxx",
    "LANGFUSE_BASE_URL": "https://cloud.langfuse.com"
  }
}
```

### Other optional parameters

| Environment variable | Default | Description |
|---------|--------|------|
| `LANGFUSE_TRACING_ENVIRONMENT` | `development` | Environment label used to filter the Langfuse dashboard |
| `LANGFUSE_FLUSH_AT` | `20` | Span-count threshold for batch submission |
| `LANGFUSE_FLUSH_INTERVAL` | `10` | Periodic flush interval in seconds |
| `LANGFUSE_EXPORT_MODE` | `batched` | Export mode: `batched` or `immediate` |
| `LANGFUSE_TIMEOUT` | `5` | Request timeout in seconds |

## 4. Architecture

### 4.1 Module structure

```
src/services/langfuse/
├── index.ts          # Unified exports
├── client.ts         # OTel Provider and LangfuseSpanProcessor initialization
├── tracing.ts        # Trace/Span creation and LLM/tool observations
├── convert.ts        # Internal Message types → Langfuse's OpenAI-compatible format
└── sanitize.ts       # Data sanitization (sensitive fields, file paths, tool output)
```

### 4.2 Trace hierarchy

```
Trace (Agent Span)                       ← createTrace() / createSubagentTrace()
  ├── Generation (LLM call)              ← recordLLMObservation()
  ├── Tool Observation (tool call)       ← recordToolObservation()
  ├── Tool Observation (tool call)       ← recordToolObservation()
  └── ...
```

### 4.3 Data flow

```
query.ts  ──→  createTrace()                    # Create a root trace for each query turn
  │
  ├── claude.ts  ──→  recordLLMObservation()   # Record an LLM observation after the API call completes
  │
  ├── toolExecution.ts  ──→  recordToolObservation()  # Record every tool execution
  │
  └── query.ts  ──→  endTrace()                # Close the trace at the end of the turn

runAgent.ts  ──→  createSubagentTrace()         # Each subagent has an independent trace
```

## 5. Trace details

### 5.1 Main-agent trace

Every `query()` call, corresponding to one user conversation turn, creates a root Span of type `agent`:

- **Name**: `agent-run` or `agent-run:<querySource>`
- **Metadata**: `provider`, `model`, `agentType: "main"`
- **Session ID**: Links to Langfuse's Session feature and supports per-session aggregation

### 5.2 Subagent trace

A subagent launched through `AgentTool` creates an independent Trace:

- **Name**: `agent:<agentType>`
- **Metadata**: `provider`, `model`, `agentType`, `agentId`
- Independent of the main Trace, with its own Session association

### 5.3 LLM Generation

Every API call is recorded as a Span of type `generation`:

- **Name**: Mapped by provider, such as `ChatAnthropic`, `ChatOpenAI`, or `ChatBedrockAnthropic`
- **Recorded data**: Input messages, output messages, and input/output token usage
- **Timing**: Records `startTime`, `endTime`, and `completionStartTime` precisely for the TTFT metric

Provider-name mapping:

| Provider | Generation name |
|----------|-----------------|
| `firstParty` | `ChatAnthropic` |
| `bedrock` | `ChatBedrockAnthropic` |
| `vertex` | `ChatVertexAnthropic` |
| `foundry` | `ChatFoundry` |
| `openai` | `ChatOpenAI` |
| `gemini` | `ChatGoogleGenerativeAI` |
| `grok` | `ChatXAI` |

### 5.4 Tool execution

Every tool call is recorded as a Span of type `tool`:

- **Name**: Tool name, such as `FileEditTool` or `BashTool`
- **Recorded data**: Sanitized input, sanitized output, and `toolUseId`
- **Error marker**: `isError` flag and `level: ERROR`

## 6. Data sanitization

All data uploaded to Langfuse passes through sanitization in `sanitize.ts` to prevent disclosure of sensitive information:

### 6.1 Global sanitization (`sanitizeGlobal`)

- **Home-path replacement** — `/Users/xxx` → `~`
- **Sensitive-field masking** — replaces values of fields matching keywords such as `api_key`, `token`, `secret`, `password`, `credential`, and `auth_header` with `[REDACTED]`

### 6.2 Tool-input sanitization (`sanitizeToolInput`)

- Masks sensitive fields using the global rules
- Replaces the Home directory in `file_path`, `path`, and `directory` paths

### 6.3 Tool-output sanitization (`sanitizeToolOutput`)

| Tool | Sanitization strategy |
|------|---------|
| `FileReadTool`, `FileWriteTool`, `FileEditTool` | Redact completely and retain only the character count: `[file content redacted, N chars]` |
| `BashTool`, `PowerShellTool` | Truncate to 500 characters |
| `ConfigTool`, `MCPTool` | Redact completely |
| Other tools | Preserve unchanged |

## 7. Message-format conversion

`convert.ts` converts occ's internal Message types into the OpenAI-compatible format expected by Langfuse:

- **Input**: `UserMessage | AssistantMessage[]` plus an optional system prompt → `{ role, content }[]`
- **Output**: `AssistantMessage[]` → `{ role: 'assistant', content }`
- **Content Block mapping**:
  - `text` → `{ type: 'text', text }`
  - `thinking` / `redacted_thinking` → `{ type: 'thinking', thinking }`
  - `tool_use` → `{ type: 'tool_use', id, name, input }`
  - `tool_result` → `{ type: 'tool_result', tool_use_id, content }`
  - `image` / `document` → placeholder `[image]` / `[document: name]`

## 8. Lifecycle

1. **Initialization** — `initLangfuse()` is called when `src/entrypoints/init.ts` starts and creates `LangfuseSpanProcessor` and `BasicTracerProvider`
2. **Runtime** — Every tracing function checks `isLangfuseEnabled()` and returns `null` or skips work when unconfigured
3. **Shutdown** — `shutdownLangfuse()` is called when the process exits, forces a flush, and shuts down the Processor

## 9. Self-hosting Langfuse

Langfuse is open source and supports self-hosting with Docker or Kubernetes:

```bash
docker run -d \
  --name langfuse \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://... \
  langfuse/langfuse:latest
```

After self-hosting, point `LANGFUSE_BASE_URL` to your instance. See the [Langfuse self-hosting documentation](https://langfuse.com/docs/deployment/self-host) for details.

If you do not need to self-host, use [Langfuse Cloud](https://cloud.langfuse.com), which provides a free quota for testing.

## 10. Related files

| File | Description |
|------|------|
| `src/services/langfuse/client.ts` | OTel Provider initialization and lifecycle management |
| `src/services/langfuse/tracing.ts` | Trace/Span creation and observation recording |
| `src/services/langfuse/convert.ts` | Message-format conversion |
| `src/services/langfuse/sanitize.ts` | Data sanitization |
| `src/services/langfuse/__tests__/langfuse.test.ts` | Tests (568 lines) |
| `src/query.ts` | Trace integration in the main query flow |
| `src/services/tools/toolExecution.ts` | Observation recording during tool execution |
| `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` | Subagent Trace creation |
