import { afterEach, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { stripMarkdownFrontmatter } from '../review/documentView'
import { MarkdownFilePreview } from './MarkdownFilePreview'

afterEach(cleanup)

test('renders headings, tables, and local links without leaving the file', async () => {
  render(<MarkdownFilePreview source={`# Current state

A [local note](./notes.md) and an [issue](https://example.com/issue).

| Layer | Status |
| --- | --- |
| Viewer | Live |
`} />)

  expect(await screen.findByRole('heading', { name: 'Current state' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Layer' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: 'Live' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'issue' }).getAttribute('target')).toBe('_blank')
  expect(screen.getByRole('link', { name: 'local note' }).getAttribute('href')).toBe('./notes.md')
})

test('does not render YAML frontmatter as preview prose', async () => {
  render(<MarkdownFilePreview source={stripMarkdownFrontmatter(`---
name: add-dark-mode
description: Add dark mode with colors, shadows, and surfaces.
---

# Add Dark Mode

Activation notes.
`)} />)

  expect(await screen.findByRole('heading', { name: 'Add Dark Mode' })).toBeTruthy()
  expect(screen.queryByText(/add-dark-mode/)).toBeNull()
  expect(screen.queryByText(/name:/)).toBeNull()
  expect(screen.queryByText(/description:/)).toBeNull()
})
