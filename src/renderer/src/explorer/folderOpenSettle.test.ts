import { expect, test } from 'bun:test'

import {
  isLiveSnapshot,
  reportAppliedSnapshot,
  waitForLiveSnapshot
} from './folderOpenSettle'

test('a skeleton snapshot is not live, everything else is', () => {
  expect(isLiveSnapshot({ stage: 'skeleton' })).toBe(false)
  expect(isLiveSnapshot({ stage: 'live' })).toBe(true)
  expect(isLiveSnapshot({})).toBe(true)
})

test('a live snapshot for the waited root settles the wait', async () => {
  const settled = waitForLiveSnapshot('/repo', 5_000)
  let done = false
  void settled.then(() => { done = true })
  await Promise.resolve()
  expect(done).toBe(false)

  reportAppliedSnapshot({ root: '/repo', stage: 'live' })
  await settled
  expect(done).toBe(true)
})

test('a skeleton or another root does not settle the wait', async () => {
  const settled = waitForLiveSnapshot('/repo', 30)
  reportAppliedSnapshot({ root: '/repo', stage: 'skeleton' })
  reportAppliedSnapshot({ root: '/other', stage: 'live' })
  let done = false
  void settled.then(() => { done = true })
  await Promise.resolve()
  expect(done).toBe(false)
  await settled
  expect(done).toBe(true)
})

test('the deadline releases a folder whose snapshot never arrives', async () => {
  const started = Date.now()
  await waitForLiveSnapshot('/never', 20)
  expect(Date.now() - started).toBeGreaterThanOrEqual(15)
})

test('reporting a snapshot with no waiters is inert', () => {
  expect(() => reportAppliedSnapshot({ root: '/repo', stage: 'live' })).not.toThrow()
})
