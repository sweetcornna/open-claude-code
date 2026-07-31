/**
 * Kept in its own module so prompt/system-prompt code can reference the tool
 * name without importing MonitorTool.tsx (which pulls in ink, Shell and the
 * task runtime).
 */
export const MONITOR_TOOL_NAME = 'Monitor'
