import { describe, expect, test } from 'bun:test'
import { getTurndownService } from '../utils.js'

describe('WebFetch turndown HTML→markdown', () => {
  test('strips <script> body text out of the markdown', async () => {
    const html = `<html><head>
      <script>var SECRET_BUNDLE = "do-not-summarize-this-js";</script>
      <style>.x{color:#SECRET_CSS}</style>
    </head><body><p>Real page content.</p></body></html>`
    const md = (await getTurndownService()).turndown(html)
    expect(md).toContain('Real page content.')
    expect(md).not.toContain('SECRET_BUNDLE')
    expect(md).not.toContain('do-not-summarize-this-js')
    expect(md).not.toContain('SECRET_CSS')
  })

  test('strips <noscript> and <iframe> content too', async () => {
    const html = `<body>
      <noscript>NOSCRIPT_FALLBACK_TEXT</noscript>
      <iframe>IFRAME_INNER_TEXT</iframe>
      <p>Kept.</p>
    </body>`
    const md = (await getTurndownService()).turndown(html)
    expect(md).toContain('Kept.')
    expect(md).not.toContain('NOSCRIPT_FALLBACK_TEXT')
    expect(md).not.toContain('IFRAME_INNER_TEXT')
  })
})
