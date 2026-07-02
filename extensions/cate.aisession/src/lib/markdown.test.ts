// =============================================================================
// Markdown renderer tests — the safety invariants (escape first, format second)
// and the code-span placeholder round-trip, which must survive input that
// contains bare numbers or stray NUL delimiter characters.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('escapes HTML instead of rendering it', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('leaves bare numbers in prose untouched', () => {
    expect(renderMarkdown('I have 5 apples and 12 pears')).toContain('I have 5 apples and 12 pears')
  })

  it('restores code spans without disturbing surrounding numbers', () => {
    const html = renderMarkdown('run `ls -la` in 2 seconds')
    expect(html).toContain('<code>ls -la</code>')
    expect(html).toContain('in 2 seconds')
  })

  it('strips NUL characters so they cannot collide with the placeholder', () => {
    const html = renderMarkdown('a\u00001\u0000b and `code`')
    expect(html).toContain('<code>code</code>')
    // The NUL-wrapped "1" is plain text, not a placeholder reference.
    expect(html).toContain('a1b')
  })

  it('tolerates an unclosed code fence', () => {
    const html = renderMarkdown('```js\nconst x = 1')
    expect(html).toContain('<pre><code class="lang-js">const x = 1</code></pre>')
  })
})
