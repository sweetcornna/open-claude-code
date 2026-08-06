import { readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { findGitBashPathOrNull } from '../utils/filesystem/windowsPaths.js'
import { findGitRoot } from '../utils/git/git.js'

/**
 * `claude up` — run the "# claude up" section from the nearest CLAUDE.md.
 *
 * Walks up from CWD looking for CLAUDE.md files, extracts the section
 * under the `# claude up` heading, and executes it as a shell script.
 *
 * ANT-only command (USER_TYPE === "ant").
 */
export async function up(): Promise<void> {
  const cwd = process.cwd()
  const gitRoot = findGitRoot(cwd)
  const searchDirs = gitRoot ? [gitRoot, cwd] : [cwd]

  let upSection: string | null = null

  for (const dir of searchDirs) {
    const claudeMdPath = join(dir, 'CLAUDE.md')
    try {
      const content = readFileSync(claudeMdPath, 'utf-8')
      upSection = extractUpSection(content)
      if (upSection) {
        console.log(`Found "# claude up" in ${claudeMdPath}`)
        break
      }
    } catch {
      // File not found — continue searching
    }
  }

  if (!upSection) {
    console.log(
      'No "# claude up" section found in CLAUDE.md.\n' +
        'Add a section like:\n\n' +
        '  # claude up\n' +
        '  ```bash\n' +
        '  npm install\n' +
        '  npm run build\n' +
        '  ```',
    )
    return
  }

  console.log('Running:\n')
  console.log(upSection)
  console.log()

  // A bare 'bash' on Windows resolves to C:\\Windows\\System32\\bash.exe — the
  // WSL launcher, not a shell — which would run CLAUDE.md's setup commands
  // inside a Linux distro in a window of its own. Use the same Git Bash the
  // Bash tool and hook runner resolve to; without one there is no POSIX shell
  // to run this section in, so say so instead of guessing.
  const bashPath =
    process.platform === 'win32' ? findGitBashPathOrNull() : 'bash'
  if (!bashPath) {
    console.error(
      'This section needs a POSIX shell. Install Git for Windows ' +
        '(https://git-scm.com/downloads/win), or set CLAUDE_CODE_GIT_BASH_PATH ' +
        'to your bash.exe.',
    )
    return
  }

  const result = spawnSync(bashPath, ['-c', upSection], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  })

  if (result.status !== 0) {
    console.error(`\nclaude up failed with exit code ${result.status}`)
    process.exitCode = result.status ?? 1
  } else {
    console.log('\nclaude up completed successfully.')
  }
}

/**
 * Extract the content under "# claude up" heading from markdown.
 * Returns the text between `# claude up` and the next `#` heading (or EOF).
 * Strips fenced code block markers if present.
 */
function extractUpSection(markdown: string): string | null {
  const lines = markdown.split('\n')
  let inSection = false
  const sectionLines: string[] = []

  for (const line of lines) {
    if (/^#\s+claude\s+up\b/i.test(line)) {
      inSection = true
      continue
    }
    if (inSection && /^#\s/.test(line)) {
      break
    }
    if (inSection) {
      sectionLines.push(line)
    }
  }

  if (sectionLines.length === 0) return null

  // Strip fenced code block markers
  let text = sectionLines.join('\n').trim()
  text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')

  return text.trim() || null
}
