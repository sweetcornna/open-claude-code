import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { CHROME_NATIVE_HOST_ISOLATION_ERROR } from './setup.js'

const OFFICIAL_NATIVE_HOST = 'com.anthropic.claude_code_browser_extension'
const OFFICIAL_EXTENSION = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const sourceDir = import.meta.dir
const repoRoot = join(sourceDir, '..', '..', '..')

async function outputText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

async function findOfficialHostManifests(root: string): Promise<string[]> {
  return Array.fromAsync(
    new Bun.Glob(`**/${OFFICIAL_NATIVE_HOST}.json`).scan({
      cwd: root,
      dot: true,
    }),
  )
}

describe('Chrome native-host isolation', () => {
  test('installer rejects before writing an official manifest or registry key', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'occ-chrome-isolation-'))
    const setupUrl = pathToFileURL(join(sourceDir, 'setup.ts')).href
    const manifestBinaryPath = join(sandbox, 'open-claude-code-native-host')
    const expression = `
      const { installChromeNativeHostManifest } = await import(${JSON.stringify(setupUrl)});
      try {
        await installChromeNativeHostManifest(${JSON.stringify(manifestBinaryPath)});
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    `

    try {
      const child = Bun.spawn([process.execPath, '--eval', expression], {
        cwd: sandbox,
        env: {
          ...process.env,
          APPDATA: sandbox,
          HOME: sandbox,
          LOCALAPPDATA: sandbox,
          PATH: '',
          USERPROFILE: sandbox,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        outputText(child.stdout),
        outputText(child.stderr),
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain(CHROME_NATIVE_HOST_ISOLATION_ERROR)
      expect(await findOfficialHostManifests(sandbox)).toEqual([])
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test('legacy setup script fails without invoking a native-host registrar', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'occ-chrome-script-'))
    const scriptPath = join(repoRoot, 'scripts', 'setup-chrome-mcp.mjs')
    const nodeExecutable = Bun.which('node')
    if (!nodeExecutable) {
      throw new Error('node executable is required for this regression test')
    }

    try {
      const child = Bun.spawn(
        [nodeExecutable, scriptPath, 'register', '--browser', 'chrome'],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            APPDATA: sandbox,
            HOME: sandbox,
            LOCALAPPDATA: sandbox,
            PATH: '',
            USERPROFILE: sandbox,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        outputText(child.stdout),
        outputText(child.stderr),
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('Chrome native-host setup is disabled')
      expect(await readdir(sandbox)).toEqual([])
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test.each([
    '',
    'ant',
  ])('hidden MCP entrypoint fails without an isolated bridge for USER_TYPE=%s', async userType => {
    const sandbox = await mkdtemp(join(tmpdir(), 'occ-chrome-mcp-entrypoint-'))
    const cliPath = join(repoRoot, 'src', 'entrypoints', 'cli.tsx')

    try {
      const child = Bun.spawn(
        [process.execPath, 'run', cliPath, '--claude-in-chrome-mcp'],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            APPDATA: sandbox,
            HOME: sandbox,
            LOCALAPPDATA: sandbox,
            OCC_CONFIG_DIR: join(sandbox, '.occ'),
            USERPROFILE: sandbox,
            USER_TYPE: userType,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        outputText(child.stdout),
        outputText(child.stderr),
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain(CHROME_NATIVE_HOST_ISOLATION_ERROR)
      expect(stderr).not.toContain('claude-mcp-browser-bridge-')
      expect(await findOfficialHostManifests(sandbox)).toEqual([])
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test('hidden native-host entrypoint fails before starting the official host', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'occ-chrome-entrypoint-'))
    const cliPath = join(repoRoot, 'src', 'entrypoints', 'cli.tsx')

    try {
      const child = Bun.spawn(
        [process.execPath, 'run', cliPath, '--chrome-native-host'],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            APPDATA: sandbox,
            HOME: sandbox,
            LOCALAPPDATA: sandbox,
            USERPROFILE: sandbox,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        outputText(child.stdout),
        outputText(child.stderr),
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain(CHROME_NATIVE_HOST_ISOLATION_ERROR)
      expect(await findOfficialHostManifests(sandbox)).toEqual([])
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test('reachable setup paths contain no official host write capability', async () => {
    const setupSource = await readFile(join(sourceDir, 'setup.ts'), 'utf8')
    const cliSource = await readFile(
      join(repoRoot, 'src', 'entrypoints', 'cli.tsx'),
      'utf8',
    )
    const packageSource = await readFile(join(repoRoot, 'package.json'), 'utf8')
    const packageJson = JSON.parse(packageSource) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    const postinstallSource = await readFile(
      join(repoRoot, 'scripts', 'setup-chrome-mcp.mjs'),
      'utf8',
    )

    expect(setupSource).not.toContain(OFFICIAL_NATIVE_HOST)
    expect(setupSource).not.toContain(OFFICIAL_EXTENSION)
    expect(setupSource).not.toContain("execFileNoThrowWithCwd('reg'")
    expect(setupSource).not.toContain('writeFile(manifestPath')
    expect(cliSource).not.toContain('runChromeNativeHost')
    expect(packageJson.scripts.postinstall).not.toContain('setup-chrome-mcp')
    expect(packageJson.dependencies).not.toHaveProperty(
      '@claude-code-best/mcp-chrome-bridge',
    )
    expect(postinstallSource).not.toContain("['register'")
    expect(postinstallSource).not.toContain('execFileSync')
  })
})
