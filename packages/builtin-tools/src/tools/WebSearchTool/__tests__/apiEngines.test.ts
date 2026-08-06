import { describe, expect, test } from 'bun:test'
import {
  ARXIV_ENGINE,
  GITHUB_ENGINE,
  HACKERNEWS_ENGINE,
  KEYLESS_API_ENGINES,
  selectApiEngines,
  STACKEXCHANGE_ENGINE,
  WIKIPEDIA_ENGINE,
} from '../adapters/apiEngines'

// Fixtures are trimmed copies of real responses captured from the live
// endpoints, so a schema drift shows up here rather than in production.

describe('WIKIPEDIA_ENGINE', () => {
  const BODY = JSON.stringify({
    query: {
      search: [
        {
          title: 'Bun (software)',
          snippet:
            'open-source portal <span class="searchmatch">Bun</span> is a JavaScript runtime',
        },
        { title: 'Node.js', snippet: 'A JavaScript runtime' },
      ],
    },
  })

  test('rebuilds the canonical article URL from the title', () => {
    expect(WIKIPEDIA_ENGINE.parse(BODY)).toEqual([
      {
        title: 'Bun (software)',
        url: 'https://en.wikipedia.org/wiki/Bun_(software)',
        snippet: 'open-source portal Bun is a JavaScript runtime',
      },
      {
        title: 'Node.js',
        url: 'https://en.wikipedia.org/wiki/Node.js',
        snippet: 'A JavaScript runtime',
      },
    ])
  })

  test('strips the searchmatch markup out of the snippet', () => {
    expect(WIKIPEDIA_ENGINE.parse(BODY)[0]?.snippet).not.toContain('<span')
  })
})

describe('STACKEXCHANGE_ENGINE', () => {
  test('decodes the HTML-escaped title and builds a snippet from the metadata', () => {
    const body = JSON.stringify({
      items: [
        {
          title: 'Why does &quot;bun test&quot; fail?',
          link: 'https://stackoverflow.com/questions/1',
          tags: ['bun', 'testing'],
          score: 7,
          answer_count: 2,
          is_answered: true,
        },
      ],
    })
    expect(STACKEXCHANGE_ENGINE.parse(body)).toEqual([
      {
        title: 'Why does "bun test" fail?',
        url: 'https://stackoverflow.com/questions/1',
        snippet: 'score 7 · 2 answers · answered · tags: bun, testing',
      },
    ])
  })

  test('returns nothing for the empty-result body the API really sends', () => {
    // Verified live: a query with no Stack Overflow hits answers with this
    // exact 67-byte payload, not an error.
    expect(
      STACKEXCHANGE_ENGINE.parse(
        '{"items":[],"has_more":false,"quota_max":300,"quota_remaining":296}',
      ),
    ).toEqual([])
  })
})

describe('HACKERNEWS_ENGINE', () => {
  test('keeps a story URL and falls back to the thread permalink for comments', () => {
    const body = JSON.stringify({
      hits: [
        {
          objectID: '1',
          title: 'Bun 1.1',
          url: 'https://bun.sh/blog/bun-v1.1',
          points: 900,
          num_comments: 400,
        },
        {
          objectID: '2',
          story_title: 'Bun 1.1',
          comment_text: 'Bun is <em>fast</em>',
        },
      ],
    })
    expect(HACKERNEWS_ENGINE.parse(body)).toEqual([
      {
        title: 'Bun 1.1',
        url: 'https://bun.sh/blog/bun-v1.1',
        snippet: '900 points · 400 comments',
      },
      {
        title: 'Bun 1.1',
        url: 'https://news.ycombinator.com/item?id=2',
        snippet: 'Bun is fast',
      },
    ])
  })
})

describe('GITHUB_ENGINE', () => {
  test('uses the full name as the title and appends the star count', () => {
    const body = JSON.stringify({
      items: [
        {
          full_name: 'oven-sh/bun',
          html_url: 'https://github.com/oven-sh/bun',
          description: 'Incredibly fast JavaScript runtime',
          stargazers_count: 75000,
        },
        {
          full_name: 'x/y',
          html_url: 'https://github.com/x/y',
          stargazers_count: 3,
        },
      ],
    })
    expect(GITHUB_ENGINE.parse(body)).toEqual([
      {
        title: 'oven-sh/bun',
        url: 'https://github.com/oven-sh/bun',
        snippet: 'Incredibly fast JavaScript runtime (★75000)',
      },
      {
        title: 'x/y',
        url: 'https://github.com/x/y',
        snippet: 'GitHub repository (★3)',
      },
    ])
  })
})

describe('ARXIV_ENGINE', () => {
  test('parses the Atom feed and upgrades the permalink to https', () => {
    const body = `<feed>
      <entry>
        <id>http://arxiv.org/abs/2201.00978v1</id>
        <title>PyramidTNT: Improved Transformer-in-Transformer Baselines</title>
        <summary>Transformer networks have achieved great progress.</summary>
      </entry>
    </feed>`
    expect(ARXIV_ENGINE.parse(body)).toEqual([
      {
        title: 'PyramidTNT: Improved Transformer-in-Transformer Baselines',
        url: 'https://arxiv.org/abs/2201.00978v1',
        snippet: 'Transformer networks have achieved great progress.',
      },
    ])
  })

  test('parses repeatedly (the entry regex is global and must reset)', () => {
    const body =
      '<entry><id>http://arxiv.org/abs/1</id><title>A</title></entry>'
    expect(ARXIV_ENGINE.parse(body)).toHaveLength(1)
    expect(ARXIV_ENGINE.parse(body)).toHaveLength(1)
  })
})

describe('parse robustness', () => {
  test.each(
    KEYLESS_API_ENGINES.map(engine => [engine.name, engine] as const),
  )('%s returns [] instead of throwing on junk', (_name, engine) => {
    for (const body of ['', 'not json', '{}', '{"items":null}', '<html>']) {
      expect(engine.parse(body)).toEqual([])
    }
  })
})

describe('selectApiEngines', () => {
  test('always includes the broad-index engines', () => {
    const names = selectApiEngines('weather in tokyo').map(e => e.name)
    expect(names).toContain('wikipedia')
    expect(names).toContain('stackexchange')
    expect(names).toContain('hackernews')
  })

  test('keeps the narrow engines out of an unrelated query', () => {
    const names = selectApiEngines('weather in tokyo').map(e => e.name)
    expect(names).not.toContain('github')
    expect(names).not.toContain('arxiv')
  })

  test('routes repository-shaped queries to GitHub', () => {
    expect(
      selectApiEngines('best rust cli library').map(e => e.name),
    ).toContain('github')
  })

  test('routes academic queries to arXiv, in English and Chinese', () => {
    expect(selectApiEngines('attention paper').map(e => e.name)).toContain(
      'arxiv',
    )
    expect(selectApiEngines('大模型 论文').map(e => e.name)).toContain('arxiv')
  })

  test('preserves registry order so a routed specialist never leads', () => {
    expect(selectApiEngines('github library paper').map(e => e.name)).toEqual([
      'wikipedia',
      'stackexchange',
      'hackernews',
      'github',
      'arxiv',
    ])
  })
})
