/**
 * The generated `bin` entrypoints, shared by both builders.
 *
 * `build.ts` (Bun) and `scripts/post-build.ts` (Vite) each emit
 * `dist/cli-bun.js` and `dist/cli-node.js`. They used to write the same
 * one-line `import "./cli.js"` independently, which was harmless while the
 * line was trivial. It stopped being trivial: an entrypoint now has to enter
 * the runtime farm before a single chunk is imported (see
 * src/services/autoUpdate/runtimeFarm.ts), and a builder that missed that
 * would silently produce a bundle whose sessions still break when
 * `install -g` replaces the package directory. One source, no drift.
 */
import { chmodSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The runtime-farm bootstrap, built separately from the main bundle.
 *
 * It has to run *before* the first chunk is imported (a process cannot re-root
 * its own module resolution afterwards), so it cannot live in the chunk graph
 * it is about to redirect. A standalone, self-contained file — node builtins
 * only, ~7KB — keeps the entrypoint's dependency on it to one static import
 * that resolves next to itself, whichever tree it is running from.
 */
const RUNTIME_FARM_SOURCE = 'src/services/autoUpdate/runtimeFarm.ts'
const RUNTIME_FARM_OUTPUT = 'runtime-farm.js'

async function buildRuntimeFarmBootstrap(outdir: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [RUNTIME_FARM_SOURCE],
    target: 'node',
    format: 'esm',
    minify: true,
  })
  if (!built.success || !built.outputs[0]) {
    throw new Error(`runtime-farm bootstrap build failed: ${built.logs}`)
  }
  await writeFile(
    join(outdir, RUNTIME_FARM_OUTPUT),
    await built.outputs[0].text(),
  )
}

/**
 * An entrypoint hands control to the farm, which imports the real `cli.js`
 * from wherever it ended up. The version is stamped in here rather than read
 * from package.json at startup: it names the farm directory, and a file read
 * on the startup path would cost more than the two stats the whole mechanism
 * is budgeted at.
 */
function entrypointSource(shebang: string, version: string): string {
  return [
    shebang,
    `import { enterRuntimeFarm } from './${RUNTIME_FARM_OUTPUT}'`,
    `await enterRuntimeFarm(import.meta.url, ${JSON.stringify(version)})`,
    '',
  ].join('\n')
}

/** Emit `runtime-farm.js` plus both executable entrypoints into `outdir`. */
export async function writeEntrypoints(outdir: string): Promise<string> {
  const { version } = JSON.parse(await readFile('package.json', 'utf-8')) as {
    version: string
  }
  await buildRuntimeFarmBootstrap(outdir)

  const cliBun = join(outdir, 'cli-bun.js')
  const cliNode = join(outdir, 'cli-node.js')
  await writeFile(cliBun, entrypointSource('#!/usr/bin/env bun', version))
  await writeFile(cliNode, entrypointSource('#!/usr/bin/env node', version))
  chmodSync(cliBun, 0o755)
  chmodSync(cliNode, 0o755)
  return version
}
