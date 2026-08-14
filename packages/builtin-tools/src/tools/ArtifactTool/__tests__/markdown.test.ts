import { describe, expect, test } from 'bun:test'
import { markdownToHtml } from '../markdown.js'

describe('markdownToHtml', () => {
  test('wraps body in a full HTML document', () => {
    const out = markdownToHtml('# Hello')
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('<html')
    expect(out).toContain('</html>')
    expect(out).toContain('<style>')
  })

  test('extracts H1 as <title>', () => {
    const out = markdownToHtml('# Hello World\n\nbody')
    expect(out).toContain('<title>Hello World</title>')
    expect(out).toContain('<h1>Hello World</h1>')
  })

  test('renders GFM tables', () => {
    const md = ['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n')
    const out = markdownToHtml(md)
    expect(out).toContain('<table>')
    expect(out).toContain('<th>A</th>')
    expect(out).toContain('<td>1</td>')
  })

  test('preserves fenced code language class', () => {
    const md = '```ts\nconst x = 1\n```'
    const out = markdownToHtml(md)
    expect(out).toContain('class="language-ts"')
    expect(out).toContain('<pre>')
  })

  test('passes through inline raw HTML', () => {
    const out = markdownToHtml('<strong>raw</strong>')
    expect(out).toContain('<strong>raw</strong>')
  })

  test('renders blockquotes', () => {
    const out = markdownToHtml('> quoted')
    expect(out).toContain('<blockquote>')
  })

  test('falls back to basename when no H1 present', () => {
    const out = markdownToHtml('just body text', '/tmp/My Report.md')
    expect(out).toContain('<title>My Report</title>')
  })

  test('falls back to default when no H1 and no filename', () => {
    const out = markdownToHtml('just body text')
    expect(out).toContain('<title>Artifact</title>')
  })

  test('strips .markdown suffix in fallback title', () => {
    const out = markdownToHtml('body', '/x/foo.markdown')
    expect(out).toContain('<title>foo</title>')
  })

  test('escapes HTML in title to prevent injection', () => {
    const out = markdownToHtml('# Title <script>alert(1)</script>')
    // Title tag must not contain a literal <script>
    const titleMatch = out.match(/<title>([\s\S]*?)<\/title>/)
    expect(titleMatch).not.toBeNull()
    expect(titleMatch![1]).not.toContain('<script>')
    expect(titleMatch![1]).toContain('&lt;script&gt;')
  })

  // The document is opened straight off disk with the default local backend,
  // so the properties below are what make it usable in a real browser.

  test('keeps every styling decision inline', () => {
    const out = markdownToHtml('# Doc\n\n```ts\nconst x = 1\n```')
    // Layout, colours and the syntax palette must never depend on the network:
    // no external stylesheet, no @import, no webfont.
    expect(out).not.toContain('<link')
    expect(out).not.toContain('@import')
    const head = out.slice(0, out.indexOf('<body>'))
    expect(head).not.toMatch(/https?:\/\//)
  })

  test('is responsive: viewport meta plus a fluid content column', () => {
    const out = markdownToHtml('body')
    expect(out).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    )
    expect(out).toContain('max-width: 46rem')
    expect(out).toContain('@media (max-width: 40rem)')
    expect(out).toContain('img { max-width: 100%; height: auto; }')
  })

  test('follows the reader light/dark preference', () => {
    const out = markdownToHtml('body')
    expect(out).toContain('<meta name="color-scheme" content="light dark">')
    expect(out).toContain('@media (prefers-color-scheme: dark)')
    // Colors come from tokens redefined in the dark block, not hardcoded.
    expect(out).toContain('background: var(--bg)')
    expect(out).toContain('color: var(--fg)')
  })

  test('scrolls wide code and tables inside their own box', () => {
    const out = markdownToHtml('body')
    const preRule = out.slice(out.indexOf('\npre {'), out.indexOf('pre code'))
    expect(preRule).toContain('overflow-x: auto')
    const tableRule = out.slice(out.indexOf('\ntable {'), out.indexOf('th, td'))
    expect(tableRule).toContain('display: block')
    expect(tableRule).toContain('max-width: 100%')
    expect(tableRule).toContain('overflow: auto')
  })

  test('labels mermaid fences instead of leaving them looking broken', () => {
    const out = markdownToHtml('```mermaid\ngraph TD; A-->B;\n```')
    expect(out).toContain('class="language-mermaid"')
    expect(out).toContain('pre:has(code.language-mermaid)::before')
    expect(out).toContain("content: 'mermaid diagram source'")
  })

  // Only two things come from the network, and the page has to survive both
  // of them not arriving.

  test('pins the CDN scripts to an exact version and checks their bytes', () => {
    const out = markdownToHtml('# Doc')
    expect(out).toContain(
      'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.2/highlight.min.js',
    )
    expect(out).toContain(
      'https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js',
    )
    // A floating version would give a shared page a mutable third-party
    // script; SRI makes the bytes as pinned as the URL.
    expect(out).not.toContain('@latest')
    const tags = out.match(/<script[^>]*src=[^>]*>/g) ?? []
    expect(tags.length).toBe(2)
    for (const tag of tags) {
      expect(tag).toContain('integrity="sha512-')
      expect(tag).toContain('crossorigin="anonymous"')
      // Deferred: a hanging CDN must not hold up first paint.
      expect(tag).toContain('defer')
    }
  })

  test('every enhancement is guarded so a blocked CDN still renders', () => {
    const out = markdownToHtml('# Doc\n\n```mermaid\ngraph TD; A-->B;\n```')
    // No highlighting without hljs, no diagram without mermaid — and the
    // mermaid fence is only hoisted out of its <pre> once mermaid is present,
    // so the labelled source block is what remains otherwise.
    expect(out).toContain('if (!window.hljs) return')
    expect(out).toContain('if (!window.mermaid || rendered) return')
    const hoistCall = out.indexOf('hoist();')
    const mermaidGuard = out.indexOf('if (!window.mermaid || rendered) return')
    expect(mermaidGuard).toBeGreaterThan(-1)
    expect(hoistCall).toBeGreaterThan(mermaidGuard)
  })

  test('highlight.js never touches a mermaid fence', () => {
    const out = markdownToHtml('```mermaid\ngraph TD; A-->B;\n```')
    // Excluded by selector rather than by hoisting first: load order between
    // the two scripts then cannot mangle a diagram into highlighted "JS".
    expect(out).toContain(
      'pre code[class*="language-"]:not(.language-mermaid):not([data-hl])',
    )
    expect(out).not.toContain('highlightAll')
  })

  test('syntax colours are defined in both schemes, not borrowed from a theme', () => {
    const out = markdownToHtml('```ts\nconst x = 1\n```')
    // hljs ships single-palette stylesheets; a light one on a dark page was
    // the reason this was dropped once already.
    expect(out).not.toContain('github.min.css')
    expect(out).toContain('.hljs-keyword')
    expect(out).toContain('.hljs-string')
    expect(out).toContain('.hljs-comment')
    const dark = out.slice(out.indexOf('@media (prefers-color-scheme: dark)'))
    expect(dark).toContain('--hl-keyword:')
    expect(dark).toContain('--hl-string:')
    const light = out.slice(
      0,
      out.indexOf('@media (prefers-color-scheme: dark)'),
    )
    expect(light).toContain('--hl-keyword:')
    // hljs' own class must not repaint the code box.
    expect(out).toContain('pre code.hljs { background: none;')
  })

  test('mermaid follows the reader scheme and redraws when it changes', () => {
    const out = markdownToHtml('```mermaid\ngraph TD; A-->B;\n```')
    expect(out).toContain("theme: isDark() ? 'dark' : 'default'")
    expect(out).toContain("mq.addEventListener('change', rerenderDiagrams)")
    // Redrawing needs the source text, since mermaid bakes colours into the svg.
    expect(out).toContain('diagrams.push({ el: div, src: source })')
  })

  test('a rendered diagram scrolls in its own box like a wide table', () => {
    const out = markdownToHtml('```mermaid\ngraph TD; A-->B;\n```')
    const rule = out.slice(out.indexOf('\n.mermaid {'), out.indexOf('table {'))
    expect(rule).toContain('overflow-x: auto')
    expect(rule).toContain('.mermaid svg { max-width: 100%; height: auto; }')
  })
})
