import type { PermissionMode } from '../types/permissions.js'

export interface OccMode {
  name: string
  slug: string
  description: string
  icon: string
  systemPrompt: string
  model?: string
  ui: {
    accentColor: string
    promptPrefix: string
  }
  companionSpecies?: string
  permissions: {
    defaultMode: PermissionMode
    memoryExtract: boolean
  }
  responseStyle: {
    verbosity: 'minimal' | 'normal' | 'verbose'
  }
}
