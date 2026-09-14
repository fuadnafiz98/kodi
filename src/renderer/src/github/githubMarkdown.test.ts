import { describe, expect, test } from 'bun:test'

import { githubMarkdownClassName, isExternalMarkdownHref, resolveGitHubHref } from './githubMarkdown'

describe('markdown hrefs', () => {
  test('maps GitHub root-relative paths and leaves local paths alone', () => {
    expect(resolveGitHubHref('/owner/repo')).toBe('https://github.com/owner/repo')
    expect(resolveGitHubHref('https://example.com')).toBe('https://example.com')
    expect(resolveGitHubHref('./notes.md')).toBe('./notes.md')
  })

  test('treats http and mailto as external', () => {
    expect(isExternalMarkdownHref('https://example.com')).toBe(true)
    expect(isExternalMarkdownHref('mailto:dev@example.com')).toBe(true)
    expect(isExternalMarkdownHref('./notes.md')).toBe(false)
    expect(isExternalMarkdownHref('#heading')).toBe(false)
  })
})

describe('githubMarkdownClassName', () => {
  test('gives the raw fallback and the rendered markdown the same wrapper', () => {
    expect(githubMarkdownClassName('pr-context-markdown', 'document')).toBe('pr-context-markdown gh-markdown')
    expect(githubMarkdownClassName(undefined, 'comment')).toBe('gh-markdown comment')
    expect(githubMarkdownClassName('', 'document')).toBe('gh-markdown')
  })
})
