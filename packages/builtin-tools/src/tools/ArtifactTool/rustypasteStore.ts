import type { ArtifactStore } from './store.js'

export const rustypasteStore: ArtifactStore = {
  async upload() {
    throw new Error('The rustypaste artifact backend is not available yet.')
  },
}
