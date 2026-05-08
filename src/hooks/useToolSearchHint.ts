import * as React from 'react'
import {
  subscribeToToolSearchPrefetch,
  getToolSearchPrefetchSnapshot,
  clearToolSearchPrefetchResults,
  type ToolDiscoveryResult,
} from 'src/services/toolSearch/prefetch.js'

type ToolSearchHintItem = {
  name: string
  description: string
  score: number
}

type ToolSearchHintResult = {
  tools: ToolSearchHintItem[]
  visible: boolean
  handleSelect: (toolName: string) => void
  handleDismiss: () => void
}

const MAX_HINT_SCORE = 0.15
const MAX_HINT_TOOLS = 3

export function useToolSearchHint(): ToolSearchHintResult {
  const prefetchResult = React.useSyncExternalStore(
    subscribeToToolSearchPrefetch,
    getToolSearchPrefetchSnapshot,
  )

  const tools: ToolSearchHintItem[] = React.useMemo(() => {
    if (prefetchResult.length === 0) return []
    return prefetchResult
      .slice(0, MAX_HINT_TOOLS)
      .map((r: ToolDiscoveryResult) => ({
        name: r.name,
        description: r.description.slice(0, 60),
        score: r.score,
      }))
  }, [prefetchResult])

  const visible = tools.length > 0 && (tools[0]?.score ?? 0) >= MAX_HINT_SCORE

  const handleSelect = React.useCallback((_toolName: string) => {
    clearToolSearchPrefetchResults()
  }, [])

  const handleDismiss = React.useCallback(() => {
    clearToolSearchPrefetchResults()
  }, [])

  return { tools, visible, handleSelect, handleDismiss }
}
