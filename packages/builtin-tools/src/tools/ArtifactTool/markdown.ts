import { basename } from 'path'
import { marked, type Tokens } from 'marked'

/**
 * highlight.js and mermaid, pinned to an exact version and checked with SRI.
 *
 * Pinned because an artifact is a page the user keeps and shares: a floating
 * `@latest` would hand a third party a mutable script tag on a document that
 * outlives this session. `integrity` + `crossorigin` make the bytes as fixed
 * as the URL — a swapped file simply fails to execute, which lands the page in
 * the degraded path below rather than running something new.
 *
 * Hashes are cdnjs' own published SRI values, re-derived from the downloaded
 * bytes (sha512, base64). Bumping a version means re-deriving the hash.
 */
const HLJS_SRC =
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.2/highlight.min.js'
const HLJS_SRI =
  'sha512-VSPLUv/n1Bmn+4zoxBNwpuFAO3//79I0Aax/qHDx24R47vylPcc9PrHDCqlePwHnh3joiM7/YTQhcXyQAAxvPQ=='
const MERMAID_SRC =
  'https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js'
const MERMAID_SRI =
  'sha512-HH52omhHpZF6RfVnGiQwYgYm4H/ya2xsZYLl5xJ4+tLfX+rN4+8zF7V/H/KLeicPrKZYi1g6iBmVkk2AhXTGlg=='

/**
 * Convert a Markdown string into a complete, standalone HTML document.
 *
 * ## What ships inline and what does not
 *
 * Everything that decides how the page *looks* is inline: the stylesheet, the
 * colour tokens, the syntax palette, the bootstrap script. No external
 * stylesheet, no webfont. Two scripts are fetched from a CDN — highlight.js
 * and mermaid — because neither can be inlined (mermaid alone is ~3.3MB) and
 * both only add to a page that already reads correctly without them.
 *
 * ## Why the syntax colours are ours
 *
 * highlight.js' official themes each ship a single palette. Dropping in
 * `github.min.css` would put a light code block on a dark page, defeating the
 * `prefers-color-scheme` support below. Its token classes are just CSS
 * classes, so the palette here defines them twice — once per scheme — from the
 * same tokens the rest of the document uses.
 *
 * ## Degrading is a feature, not a fallback
 *
 * With the default `local` backend the page is opened straight off disk as
 * `file://…`, and it may be read offline, behind a proxy, or under a CSP that
 * blocks the CDN. The document is therefore authored to be complete without
 * either script: fenced code is plain (but styled and scrollable) text, and a
 * mermaid fence stays a source block carrying a `mermaid diagram source`
 * label. Both scripts are `defer`red so a hanging CDN cannot delay first
 * paint, and every enhancement is guarded by an availability check rather
 * than assumed. Nothing about the layout is loaded from the network.
 */
export function markdownToHtml(md: string, filename?: string): string {
  const body = marked.parse(md, {
    async: false,
    gfm: true,
    breaks: false,
  }) as string
  const title = extractTitle(md) ?? fallbackTitle(filename)
  return wrapDocument(body, title)
}

function extractTitle(md: string): string | undefined {
  for (const token of marked.lexer(md)) {
    if (token.type === 'heading' && (token as Tokens.Heading).depth === 1) {
      return (token as Tokens.Heading).text
    }
  }
  return undefined
}

function fallbackTitle(filename?: string): string {
  if (!filename) return 'Artifact'
  return basename(filename).replace(/\.(md|markdown)$/i, '') || 'Artifact'
}

function wrapDocument(body: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --accent: #D77757;
  --bg: #ffffff;
  --fg: #1f1d1b;
  --muted: #5c5854;
  --border: #e3dfdb;
  --surface: #f6f4f2;
  --shadow: rgba(0, 0, 0, .06);
  /* Syntax palette: highlight.js' token classes, ours in both schemes —
     see markdownToHtml. */
  --hl-comment: #79726b;
  --hl-keyword: #8a4a9e;
  --hl-string: #2f7a4a;
  --hl-number: #1f6f9e;
  --hl-title: #b3502a;
  --hl-type: #0e7490;
  --hl-attr: #96591a;
  --hl-meta: #6f6862;
  --hl-variable: #a3452c;
  --hl-add-fg: #2c6b3d;
  --hl-add-bg: rgba(44, 107, 61, .12);
  --hl-del-fg: #a13c2c;
  --hl-del-bg: rgba(161, 60, 44, .12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --accent: #E1906F;
    --bg: #1a1917;
    --fg: #e9e5e0;
    --muted: #a9a29b;
    --border: #35312d;
    --surface: #232120;
    --shadow: rgba(0, 0, 0, .4);
    --hl-comment: #8d857c;
    --hl-keyword: #cf9de8;
    --hl-string: #93cf9f;
    --hl-number: #86c3ea;
    --hl-title: #E1906F;
    --hl-type: #6ec9cf;
    --hl-attr: #e3b878;
    --hl-meta: #a9a29b;
    --hl-variable: #f0a98e;
    --hl-add-fg: #8fce9d;
    --hl-add-bg: rgba(143, 206, 157, .14);
    --hl-del-fg: #ef9a8b;
    --hl-del-bg: rgba(239, 154, 139, .14);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  max-width: 46rem;
  margin: 0 auto;
  padding: 3rem 1.5rem 6rem;
  background: var(--bg);
  color: var(--fg);
  overflow-wrap: break-word;
}
@media (max-width: 40rem) {
  body { font-size: 15px; padding: 1.75rem 1rem 4rem; }
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 2em 0 .6em; }
h1 { margin-top: 0; font-size: 1.9em; border-bottom: 2px solid var(--accent); padding-bottom: .3em; }
h2 { font-size: 1.45em; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1em; }
p, ul, ol { margin: 0 0 1em; }
ul, ol { padding-left: 1.5em; }
li { margin: .25em 0; }
a { color: var(--accent); }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.5em 0; }
img { max-width: 100%; height: auto; }
code {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: .9em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: .1em .35em;
}
pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: .9rem 1.1rem;
  margin: 0 0 1.25em;
  /* Wide code scrolls inside its own box; the page never scrolls sideways. */
  overflow-x: auto;
}
pre code { background: none; border: 0; padding: 0; font-size: .875em; }
/* highlight.js sets class="hljs" on the block it touched; its own themes would
   paint a background here, so pin it back to the page's own box. */
pre code.hljs { background: none; padding: 0; color: inherit; }
.hljs-comment, .hljs-quote { color: var(--hl-comment); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-operator, .hljs-doctag, .hljs-formula { color: var(--hl-keyword); }
.hljs-string, .hljs-regexp, .hljs-char.escape_ { color: var(--hl-string); }
.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet, .hljs-link { color: var(--hl-number); }
.hljs-title, .hljs-title.class_, .hljs-title.function_, .hljs-section, .hljs-name { color: var(--hl-title); }
.hljs-built_in, .hljs-type, .hljs-class, .hljs-selector-pseudo { color: var(--hl-type); }
.hljs-attr, .hljs-attribute, .hljs-property, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id { color: var(--hl-attr); }
.hljs-variable, .hljs-template-variable, .hljs-subst { color: var(--hl-variable); }
.hljs-meta, .hljs-meta .hljs-keyword, .hljs-meta .hljs-string, .hljs-tag { color: var(--hl-meta); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
.hljs-addition { color: var(--hl-add-fg); background: var(--hl-add-bg); }
.hljs-deletion { color: var(--hl-del-fg); background: var(--hl-del-bg); }
/* Shown only while mermaid is missing: the fence stays a labelled source
   block instead of looking like a broken diagram. */
pre:has(code.language-mermaid)::before {
  content: 'mermaid diagram source';
  display: block;
  margin-bottom: .5rem;
  font: 600 .7rem/1 -apple-system, BlinkMacSystemFont, sans-serif;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
/* A rendered diagram gets the same treatment as a wide table: it scrolls in
   its own box, and its svg never pushes the page wider than the viewport. */
.mermaid { margin: 0 0 1.25em; text-align: center; overflow-x: auto; }
.mermaid svg { max-width: 100%; height: auto; }
/* Same technique GitHub uses: the table itself becomes the scroll container. */
table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
  margin: 0 0 1.25em;
  font-size: .95em;
}
th, td { border: 1px solid var(--border); padding: .4em .75em; text-align: left; }
th { background: var(--surface); font-weight: 600; }
blockquote {
  border-left: 3px solid var(--accent);
  margin: 0 0 1.25em;
  padding: .25rem 1rem;
  color: var(--muted);
}
blockquote > :last-child { margin-bottom: 0; }
</style>
</head>
<body>
${body}
<script defer src="${HLJS_SRC}" integrity="${HLJS_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script defer src="${MERMAID_SRC}" integrity="${MERMAID_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
(function () {
  // Every step below is guarded: when a script did not arrive the page keeps
  // the markup marked.js produced, which is already readable.
  var diagrams = [];
  var rendered = false;

  function isDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function highlight() {
    if (!window.hljs) return;
    // Only fences that declared a language. Unlabelled blocks are left alone
    // on purpose: hljs auto-detection guesses, and a wrong guess paints plain
    // console output in nonsense colours. Mermaid fences are excluded here
    // rather than hoisted first, so load order between the two scripts — or
    // mermaid failing to load at all — cannot mangle a diagram as source.
    var blocks = document.querySelectorAll('pre code[class*="language-"]:not(.language-mermaid):not([data-hl])');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].setAttribute('data-hl', '1');
      try { window.hljs.highlightElement(blocks[i]); } catch (e) {}
    }
  }

  function hoist() {
    // Only reached once mermaid is known to be present, so the labelled
    // source block survives when it is not.
    var fences = document.querySelectorAll('pre > code.language-mermaid');
    for (var i = 0; i < fences.length; i++) {
      var source = fences[i].textContent;
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = source;
      diagrams.push({ el: div, src: source });
      fences[i].parentElement.replaceWith(div);
    }
  }

  function run() {
    if (!document.querySelector('.mermaid:not([data-processed])')) return;
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDark() ? 'dark' : 'default',
      // Only the type face is overridden: mermaid's own palettes stay intact
      // (they cover every diagram kind), but a diagram set in the page's font
      // reads as part of the document rather than as a pasted image.
      themeVariables: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif" }
    });
    try {
      Promise.resolve(window.mermaid.run({ querySelector: '.mermaid' })).catch(function () {});
    } catch (e) {}
  }

  function renderDiagrams() {
    // mermaid.run() is async, so "did we already start" cannot be read off the
    // DOM: boot() runs twice by design and would otherwise kick off a second
    // render over nodes the first one has not finished marking.
    if (!window.mermaid || rendered) return;
    rendered = true;
    hoist();
    run();
  }

  function boot() {
    highlight();
    renderDiagrams();
  }

  function rerenderDiagrams() {
    // mermaid bakes the theme's colours into the svg it emitted, so following
    // the reader switching schemes means rebuilding every diagram from the
    // source text kept above.
    if (!window.mermaid || !diagrams.length) return;
    for (var i = 0; i < diagrams.length; i++) {
      diagrams[i].el.removeAttribute('data-processed');
      diagrams[i].el.textContent = diagrams[i].src;
    }
    run();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // Safety net for a CDN that answers late: deferred scripts hold up
  // DOMContentLoaded, and boot() skips whatever it already did.
  window.addEventListener('load', boot);

  var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mq && mq.addEventListener) mq.addEventListener('change', rerenderDiagrams);
})();
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
      })[c] as string,
  )
}
