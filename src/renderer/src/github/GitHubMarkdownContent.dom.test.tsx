import { afterEach, expect, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { GitHubMarkdownContent, GitHubMarkdownFallback } from './GitHubMarkdownContent'

afterEach(cleanup)

test('previews GitHub webm links as a video player', async () => {
  render(<GitHubMarkdownContent source={'[Screencast From 2026-09-04 11-34-01.webm](https://github.com/user-attachments/assets/clip.webm)'} />)

  await waitFor(() => {
    expect(screen.getByLabelText('Screencast From 2026-09-04 11-34-01.webm').tagName).toBe('VIDEO')
  })
})

test('shows the source while the renderer chunk is in flight', () => {
  const { container } = render(
    <GitHubMarkdownFallback source={'# Heading'} className="pr-context-markdown" variant="comment" />
  )
  const wrapper = container.querySelector('.pr-context-markdown')

  expect(wrapper?.className).toBe('pr-context-markdown gh-markdown comment')
  expect(wrapper?.textContent).toBe('# Heading')
  // Wrapping comes from the stylesheet, not an inline style object.
  const raw = wrapper?.querySelector('pre')
  expect(raw?.className).toBe('github-markdown-fallback')
  expect(raw?.getAttribute('style')).toBeNull()
})

test('swaps the renderer into the wrapper the fallback used', async () => {
  const { container } = render(
    <GitHubMarkdownContent source={'# Heading'} className="pr-context-markdown" variant="comment" />
  )

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy()
  })
  expect(container.querySelector('.pr-context-markdown')?.className)
    .toBe('pr-context-markdown gh-markdown comment')
})
