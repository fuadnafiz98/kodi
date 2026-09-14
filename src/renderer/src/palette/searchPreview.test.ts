import { describe, expect, it } from 'bun:test'

import { tokenizeSearchPreview } from './searchPreview'

describe('search preview syntax tokens', () => {
  it('classifies common source-code tokens', () => {
    const tokens = tokenizeSearchPreview('src/App.tsx', 'export default function App() { return "ready" }', 'app')

    expect(tokens.filter((token) => token.kind === 'keyword').map((token) => token.text)).toEqual([
      'export', 'default', 'function', 'return'
    ])
    expect(tokens.find((token) => token.text.toLowerCase() === 'app')?.match).toBe(true)
    expect(tokens.find((token) => token.text === '"ready"')?.kind).toBe('string')
  })

  it('recognizes hash comments only for languages that use them', () => {
    expect(tokenizeSearchPreview('script.py', '# explain this', '')[0]?.kind).toBe('comment')
    expect(tokenizeSearchPreview('styles.css', '#app { color: red }', '')[0]?.kind).toBe('plain')
  })
})
