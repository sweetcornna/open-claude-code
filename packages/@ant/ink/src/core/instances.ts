// Store all instances of Ink (ink.tsx) to ensure that consecutive render() calls
// use the same instance of Ink and don't create a new one.
//
// This map lives in its own file so that lookups (AlternateScreen, useSelection,
// …) don't have to pull in root.js. root.ts owns both halves of the lifetime:
// it registers the instance and hands Ink an `onDispose` that removes it again
// on unmount. Ink cannot touch this map directly — the map names the Ink type,
// so an import back the other way would be a cycle.

import type Ink from './ink.js'

const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
