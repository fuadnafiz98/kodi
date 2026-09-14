import { afterEach, expect, test } from 'bun:test'

import {
  clearHibernationVetoes,
  firstHibernationBlocker,
  registerHibernationVeto
} from './useHibernation'

// The registry is module state shared by every component that registers a veto,
// so each test starts from an empty one.
afterEach(clearHibernationVetoes)

test('no vetoes means hibernation is allowed', () => {
  expect(firstHibernationBlocker()).toBeNull()
})

test('a veto that returns a reason blocks, and unregistering clears it', () => {
  const remove = registerHibernationVeto(() => '2 files have unsaved edits')
  expect(firstHibernationBlocker()).toBe('2 files have unsaved edits')
  remove()
  expect(firstHibernationBlocker()).toBeNull()
})

test('a veto that throws refuses rather than allowing', () => {
  registerHibernationVeto(() => { throw new Error('boom') })
  expect(firstHibernationBlocker()).toBe('a hibernation guard failed')
})

test('the first refusing veto is the one reported', () => {
  registerHibernationVeto(() => null)
  registerHibernationVeto(() => 'a review is still loading')
  registerHibernationVeto(() => 'a terminal session is running')
  expect(firstHibernationBlocker()).toBe('a review is still loading')
})
