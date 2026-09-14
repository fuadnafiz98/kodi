import { expect, test } from 'bun:test'

import { revealInExplorer, setExplorerRevealHandler } from './explorerReveal'

test('reveals through the registered workspace handler', () => {
  const revealed: string[] = []
  const stop = setExplorerRevealHandler((path) => revealed.push(path))
  expect(revealInExplorer('src/main')).toBe(true)
  expect(revealed).toEqual(['src/main'])
  stop()
})

test('reveals nothing once the workspace unmounts', () => {
  const stop = setExplorerRevealHandler(() => {
    throw new Error('the unmounted workspace must not be called')
  })
  stop()
  expect(revealInExplorer('src/main')).toBe(false)
})

test('a later workspace replaces the previous handler and the stale stop is inert', () => {
  const revealed: string[] = []
  const stopFirst = setExplorerRevealHandler(() => revealed.push('first'))
  setExplorerRevealHandler(() => revealed.push('second'))
  stopFirst()
  expect(revealInExplorer('src')).toBe(true)
  expect(revealed).toEqual(['second'])
})

test('an empty path reveals nothing', () => {
  const stop = setExplorerRevealHandler(() => {
    throw new Error('an empty path must not reach the tree')
  })
  expect(revealInExplorer('')).toBe(false)
  stop()
})
