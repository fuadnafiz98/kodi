import { describe, expect, it } from 'bun:test'

import {
  advanceStreamingMarkdown,
  appendStreamingMarkdown,
  EMPTY_STREAMING_MARKDOWN,
  keyForBlock,
  parseInline,
  parseMarkdown
} from './markdown'

describe('parseInline', () => {
  it('splits inline code, strong, and emphasis runs', () => {
    expect(parseInline('use `git diff` for **big** and _small_ changes')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'code', text: 'git diff' },
      { kind: 'text', text: ' for ' },
      { kind: 'strong', text: 'big' },
      { kind: 'text', text: ' and ' },
      { kind: 'emphasis', text: 'small' },
      { kind: 'text', text: ' changes' }
    ])
  })

  it('returns nothing for empty text', () => {
    expect(parseInline('')).toEqual([])
  })
})

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, and quotes', () => {
    const blocks = parseMarkdown('# Summary\n\nThis PR adds an inbox.\n\n> Watch the poll interval.')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, content: [{ kind: 'text', text: 'Summary' }] },
      { kind: 'paragraph', content: [{ kind: 'text', text: 'This PR adds an inbox.' }] },
      { kind: 'quote', content: [{ kind: 'text', text: 'Watch the poll interval.' }] }
    ])
  })

  it('reads fenced code with a language', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1\nconst b = 2\n```')
    expect(blocks).toEqual([{ kind: 'code', language: 'ts', text: 'const a = 1\nconst b = 2' }])
  })

  it('keeps an unterminated fence as a code block while streaming', () => {
    const blocks = parseMarkdown('Explanation:\n\n```ts\nconst partial = ')
    expect(blocks[0]).toEqual({ kind: 'paragraph', content: [{ kind: 'text', text: 'Explanation:' }] })
    expect(blocks[1]).toEqual({ kind: 'code', language: 'ts', text: 'const partial = ' })
  })

  it('groups list items and separates ordered from unordered runs', () => {
    const blocks = parseMarkdown('- first\n- second\n1. one\n2. two')
    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]]
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]]
      }
    ])
  })

  it('joins wrapped paragraph lines and drops blank runs', () => {
    expect(parseMarkdown('one\ntwo\n\n\nthree')).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: 'one two' }] },
      { kind: 'paragraph', content: [{ kind: 'text', text: 'three' }] }
    ])
  })

  it('returns nothing for an empty answer', () => {
    expect(parseMarkdown('')).toEqual([])
  })
})

// The incremental parser only exists to avoid re-parsing settled text, so the
// contract that matters is that it always agrees with a full parse.
function streamInChunks(source: string, size: number): ReturnType<typeof advanceStreamingMarkdown> {
  let state = EMPTY_STREAMING_MARKDOWN
  for (let index = 0; index < source.length; index += size) {
    state = advanceStreamingMarkdown(state, source.slice(0, index + size))
  }
  return state
}

describe('advanceStreamingMarkdown', () => {
  const answer = [
    '## Summary',
    '',
    'This change adds an inbox and',
    'wraps across lines.',
    '',
    '- first item',
    '- second item',
    '- third item',
    '',
    '```ts',
    'const a = 1',
    '',
    'const b = 2',
    '```',
    '',
    '> A quote after the fence.',
    '',
    'Trailing paragraph.'
  ].join('\n')

  it('matches a full parse no matter how the text is chunked', () => {
    const expected = parseMarkdown(answer)
    for (const size of [1, 2, 3, 7, 13, 64, 4096]) {
      expect(streamInChunks(answer, size).blocks).toEqual(expected)
    }
  })

  it('matches a full parse at every intermediate prefix', () => {
    let state = EMPTY_STREAMING_MARKDOWN
    for (let length = 0; length <= answer.length; length += 1) {
      const prefix = answer.slice(0, length)
      state = advanceStreamingMarkdown(state, prefix)
      expect(state.blocks).toEqual(parseMarkdown(prefix))
    }
  })

  it('never settles inside a fence, so a blank line in code stays code', () => {
    const source = '```ts\nconst a = 1\n\nconst b = 2\n'
    const state = advanceStreamingMarkdown(EMPTY_STREAMING_MARKDOWN, source)
    expect(state.settledLength).toBe(0)
    expect(state.blocks).toEqual(parseMarkdown(source))
    expect(state.blocks[0]?.kind).toBe('code')
  })

  it('reuses settled blocks instead of reparsing them', () => {
    const first = advanceStreamingMarkdown(EMPTY_STREAMING_MARKDOWN, 'Settled paragraph.\n\ntail')
    expect(first.settled).toHaveLength(1)
    const second = advanceStreamingMarkdown(first, 'Settled paragraph.\n\ntail grows')
    // Identity proves the settled prefix was carried over rather than re-parsed.
    expect(second.settled[0]).toBe(first.settled[0])
    expect(second.blocks).toEqual(parseMarkdown('Settled paragraph.\n\ntail grows'))
  })

  it('starts over when the answer is truncated from the front', () => {
    const first = advanceStreamingMarkdown(EMPTY_STREAMING_MARKDOWN, 'Old start.\n\nkept tail')
    const truncated = advanceStreamingMarkdown(first, 'kept tail')
    expect(truncated.settledLength).toBe(0)
    expect(truncated.blocks).toEqual(parseMarkdown('kept tail'))
  })
})

describe('appendStreamingMarkdown', () => {
  const paragraph = (index: number): string => `Paragraph ${index} of the answer.\n\n`

  it('matches a from-scratch parse while under the cap', () => {
    let state = EMPTY_STREAMING_MARKDOWN
    for (let index = 0; index < 5; index += 1) state = appendStreamingMarkdown(state, paragraph(index), 10_000)

    expect(state.blocks).toEqual(parseMarkdown(state.source))
  })

  it('trims on a settled boundary and keeps parsing incrementally past the cap', () => {
    const limit = 400
    let state = EMPTY_STREAMING_MARKDOWN
    for (let index = 0; index < 40; index += 1) state = appendStreamingMarkdown(state, paragraph(index), limit)

    expect(state.source.length).toBeLessThanOrEqual(limit)
    expect(state.blocks).toEqual(parseMarkdown(state.source))
    // The retained blocks were carried over, not re-parsed: identity survives
    // the next chunk, which is what the block memoization depends on.
    const before = state.settled.at(-1)!
    const after = appendStreamingMarkdown(state, paragraph(41), limit)
    expect(after.settled).toContain(before)
    expect(after.blocks).toEqual(parseMarkdown(after.source))
  })

  it('falls back to a raw cut when one unsettled block is longer than the cap', () => {
    const state = appendStreamingMarkdown(EMPTY_STREAMING_MARKDOWN, 'x'.repeat(300), 100)

    expect(state.source).toHaveLength(100)
    expect(state.blocks).toEqual(parseMarkdown(state.source))
  })
})

describe('keyForBlock', () => {
  it('keeps a list key stable while items stream in', () => {
    const keyAfter = (source: string): string =>
      keyForBlock(parseMarkdown(source)[0]!, new Map<string, number>())
    expect(keyAfter('- first item')).toBe(keyAfter('- first item\n- second item'))
    expect(keyAfter('- first item')).toBe(keyAfter('- first item\n- second\n- third'))
  })
})
