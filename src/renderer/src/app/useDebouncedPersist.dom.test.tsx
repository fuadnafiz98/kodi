import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

import { useDebouncedPersist } from './useDebouncedPersist'

afterEach(cleanup)

test('coalesces rapid values and persists only the latest value', async () => {
  const persist = mock((_value: number) => {})
  const { rerender } = renderHook(
    ({ value }: { value: number }) => useDebouncedPersist(value, persist, 20),
    { initialProps: { value: 1 } }
  )

  rerender({ value: 2 })
  rerender({ value: 3 })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  })

  expect(persist).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenLastCalledWith(3)
})

test('flushes the latest value on unmount', () => {
  const persist = mock((_value: number) => {})
  const { rerender, unmount } = renderHook(
    ({ value }: { value: number }) => useDebouncedPersist(value, persist, 1_000),
    { initialProps: { value: 1 } }
  )

  rerender({ value: 2 })
  unmount()

  expect(persist).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenLastCalledWith(2)
})

test('does not persist the mount-time value until it actually changes', async () => {
  const persist = mock((_value: number) => {})
  const { unmount } = renderHook(
    ({ value }: { value: number }) => useDebouncedPersist(value, persist, 20),
    { initialProps: { value: 1 } }
  )

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  })
  expect(persist).toHaveBeenCalledTimes(0)

  unmount()
  expect(persist).toHaveBeenCalledTimes(0)

  const second = renderHook(
    ({ value }: { value: number }) => useDebouncedPersist(value, persist, 20),
    { initialProps: { value: 1 } }
  )
  second.rerender({ value: 2 })
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  })
  expect(persist).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenLastCalledWith(2)
  second.unmount()
})

test('flushes the latest value on pagehide', () => {
  const persist = mock((_value: number) => {})
  const { rerender } = renderHook(
    ({ value }: { value: number }) => useDebouncedPersist(value, persist, 1_000),
    { initialProps: { value: 1 } }
  )

  rerender({ value: 2 })
  act(() => window.dispatchEvent(new Event('pagehide')))

  expect(persist).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenLastCalledWith(2)
})
