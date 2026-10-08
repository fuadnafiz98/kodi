import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

import { useGeneratedPathTest, useReviewFileMarks } from './reviewFileMarks'

afterEach(() => {
  cleanup()
  delete (window as { repository?: unknown }).repository
})

function Probe({ world, root, paths, onMarks, onTest }: {
  world: string
  root: string
  paths: readonly string[]
  onMarks(marks: ReadonlySet<string> | null): void
  onTest(test: (path: string) => boolean): void
}): null {
  onMarks(useReviewFileMarks(world, root, paths, null))
  onTest(useGeneratedPathTest(root))
  return null
}

test('the working tree\'s answer decides "generated" for the files it asked about, the path for the rest', async () => {
  const getReviewFileMarks = mock(async () => ({ generated: ['vendor/lib.js'], categories: {} }))
  ;(window as { repository?: unknown }).repository = { getReviewFileMarks }
  let marks: ReadonlySet<string> | null = null
  let isGenerated: (path: string) => boolean = () => false
  const paths = ['pnpm-lock.yaml', 'src/a.ts', 'vendor/lib.js']
  render(<Probe world="w1" root="/repo-marks" paths={paths} onMarks={(next) => { marks = next }} onTest={(next) => { isGenerated = next }} />)
  expect(isGenerated('pnpm-lock.yaml')).toBe(true)
  await waitFor(() => expect(marks).not.toBeNull())
  expect(isGenerated('vendor/lib.js')).toBe(true)
  expect(isGenerated('pnpm-lock.yaml')).toBe(false)
  expect(isGenerated('yarn.lock')).toBe(true)
  expect(isGenerated('src/a.ts')).toBe(false)
})

test('a list with the same length and ends but another file between asks again', async () => {
  const getReviewFileMarks = mock(async () => ({ generated: [], categories: {} }))
  ;(window as { repository?: unknown }).repository = { getReviewFileMarks }
  const { rerender } = render(<Probe world="w2" root="/repo-key" paths={['a.ts', 'b.ts', 'z.ts']} onMarks={() => {}} onTest={() => {}} />)
  await waitFor(() => expect(getReviewFileMarks).toHaveBeenCalledTimes(1))
  rerender(<Probe world="w2" root="/repo-key" paths={['a.ts', 'yarn.lock', 'z.ts']} onMarks={() => {}} onTest={() => {}} />)
  await waitFor(() => expect(getReviewFileMarks).toHaveBeenCalledTimes(2))
})

test('no answer from main leaves the heuristics deciding', async () => {
  ;(window as { repository?: unknown }).repository = { getReviewFileMarks: async () => null }
  let marks: ReadonlySet<string> | null = new Set()
  render(<Probe world="w3" root="/repo-none" paths={['yarn.lock']} onMarks={(next) => { marks = next }} onTest={() => {}} />)
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(marks).toBeNull()
})
