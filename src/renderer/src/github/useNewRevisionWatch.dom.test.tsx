import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'

import { useNewRevisionWatch } from './useNewRevisionWatch'

afterEach(() => {
  cleanup()
  delete (document as { hidden?: boolean }).hidden
})

// A 20ms idle window stands in for the shipped ten seconds so a test can watch a
// whole arm-and-fire cycle.
const idleMs = 20

function hideWindow(): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
}

test('a banner raised mid-read adopts on its own once the reader goes still', async () => {
  const adopt = mock(() => {})
  document.dispatchEvent(new Event('scroll'))
  const { result } = renderHook(() => useNewRevisionWatch('new-head', 'old-head', adopt, { idleMs }))

  expect(result.current.pendingHeadOid).toBe('new-head')
  expect(adopt).toHaveBeenCalledTimes(0)

  await waitFor(() => {
    expect(adopt).toHaveBeenCalledTimes(1)
  })
  expect(result.current.pendingHeadOid).toBeNull()
})

// Every interaction pushes the deadline back, so a reader who keeps scrolling
// keeps the diff they are reading.
test('interaction pushes the deadline back', async () => {
  const adopt = mock(() => {})
  document.dispatchEvent(new Event('scroll'))
  const { result } = renderHook(() =>
    useNewRevisionWatch('new-head', 'old-head', adopt, { idleMs: 30 }))

  expect(result.current.pendingHeadOid).toBe('new-head')
  await act(async () => {
    for (let tick = 0; tick < 12; tick += 1) {
      document.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })
  expect(adopt).toHaveBeenCalledTimes(0)
  expect(result.current.pendingHeadOid).toBe('new-head')

  await waitFor(() => {
    expect(adopt).toHaveBeenCalledTimes(1)
  })
})

// The caret is the one kind of stillness that is not absence: a reload would eat
// the draft under it.
test('a caret in a field holds the banner until it leaves', async () => {
  const adopt = mock(() => {})
  render(<textarea aria-label="Review comment" />)
  screen.getByLabelText('Review comment').focus()

  const { result } = renderHook(() => useNewRevisionWatch('new-head', 'old-head', adopt, { idleMs }))
  await new Promise((resolve) => setTimeout(resolve, idleMs * 4))
  expect(adopt).toHaveBeenCalledTimes(0)
  expect(result.current.pendingHeadOid).toBe('new-head')

  act(() => { screen.getByLabelText('Review comment').blur() })
  await waitFor(() => {
    expect(adopt).toHaveBeenCalledTimes(1)
  })
})

test('hiding the window adopts a pending head at once', async () => {
  const adopt = mock(() => {})
  document.dispatchEvent(new Event('scroll'))
  const { result } = renderHook(() =>
    useNewRevisionWatch('new-head', 'old-head', adopt, { idleMs: 10_000 }))
  expect(result.current.pendingHeadOid).toBe('new-head')

  hideWindow()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })

  expect(adopt).toHaveBeenCalledTimes(1)
  expect(result.current.pendingHeadOid).toBeNull()
})

// Until the review catches up the heads still differ, so a poll every 30s would
// otherwise ask for the same reload again and again — including across the
// remount a tab switch and a switch back produce.
test('asks for a head once, however many polls report it', async () => {
  const adopt = mock(() => {})
  const { result, rerender } = renderHook(
    ({ head }: { head: string | undefined }) =>
      useNewRevisionWatch(head, 'old-head', adopt, { idleMs, reviewIdentity: 'pr-1' }),
    { initialProps: { head: 'new-head' as string | undefined } }
  )

  await waitFor(() => {
    expect(adopt).toHaveBeenCalledTimes(1)
  })
  await act(async () => { rerender({ head: undefined }) })
  await act(async () => { rerender({ head: 'new-head' }) })
  await new Promise((resolve) => setTimeout(resolve, idleMs * 3))

  expect(adopt).toHaveBeenCalledTimes(1)
  expect(result.current.pendingHeadOid).toBeNull()
})

// A reload that failed is not an answer: without this the watch goes quiet for
// the rest of the tab's life and the reader never learns the head moved.
test('a failed reload puts the banner back', async () => {
  const adopt = mock(() => false)
  document.dispatchEvent(new Event('scroll'))
  const { result } = renderHook(() => useNewRevisionWatch('new-head', 'old-head', adopt, { idleMs }))

  await waitFor(() => {
    expect(result.current.pendingHeadOid).toBe('new-head')
    expect(adopt.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})

// This workspace outlives a tab switch, so a head pending on one review must not
// reload whichever review is in front when the reader finally goes still.
test('a pending head does not survive a switch to another pull request', async () => {
  const adopt = mock(() => {})
  document.dispatchEvent(new Event('scroll'))
  const { result, rerender } = renderHook(
    ({ identity, head }: { identity: string; head: string | undefined }) =>
      useNewRevisionWatch(head, 'old-head', adopt, { idleMs: 10_000, reviewIdentity: identity }),
    { initialProps: { identity: 'pr-1', head: 'new-head' as string | undefined } }
  )
  expect(result.current.pendingHeadOid).toBe('new-head')

  await act(async () => { rerender({ identity: 'pr-2', head: undefined }) })
  expect(result.current.pendingHeadOid).toBeNull()

  hideWindow()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(adopt).toHaveBeenCalledTimes(0)
})
