import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { PerformanceMetrics, RepositoryApi } from '../../../shared/contracts'
import { PerformanceHud } from './PerformanceHud'
import { clearMemorySamples } from './performanceHistory'

afterEach(() => {
  cleanup()
  clearMemorySamples()
  delete window.repository
  delete (window as Partial<Window>).requestIdleCallback
  delete (window as Partial<Window>).cancelIdleCallback
})

function openHud(): HTMLElement {
  const summary = document.querySelector<HTMLElement>('.performance-hud > summary')!
  fireEvent.click(summary)
  return summary
}

function metrics(sampledAt: number, workingSetMegabytes = 512): PerformanceMetrics {
  return {
    cpuPercent: 1.2,
    gpuProcessCpuPercent: 0.4,
    workingSetMegabytes,
    rendererPrivateMegabytes: 128,
    lastRendererTermination: null,
    processCount: 4,
    production: true,
    sampledAt,
    detail: null
  }
}

test('shows the latest sample time and stops claiming a failed sample is live', async () => {
  const sampledAt = Date.UTC(2026, 7, 26, 12, 34, 56)
  let requestCount = 0
  window.repository = {
    getPerformanceMetrics: async () => {
      requestCount += 1
      if (requestCount === 1) return metrics(sampledAt)
      throw new Error('sampling failed')
    }
  } as unknown as RepositoryApi

  render(<PerformanceHud />)

  expect(requestCount).toBe(0)
  openHud()

  await waitFor(() => expect(screen.getByText('Live')).toBeTruthy())
  expect(document.querySelector('time')?.dateTime).toBe(new Date(sampledAt).toISOString())

  openHud()

  await waitFor(() => expect(screen.getByText('Stale')).toBeTruthy())
  expect(screen.queryByText('Live')).toBeNull()
})

test('shows a visible warning when the working set reaches 1 GB', async () => {
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now(), 1_024)
  } as unknown as RepositoryApi

  render(<PerformanceHud />)
  openHud()

  await waitFor(() => expect(document.querySelector('.performance-memory.high-memory')).toBeTruthy())
  expect(document.querySelector('.performance-signal.high-memory')).toBeTruthy()
  expect(document.querySelector('.performance-hud > summary')?.getAttribute('aria-label')).toContain('High memory warning')
  expect(await screen.findByText('High · 4 processes')).toBeTruthy()
})

test('keeps CPU and GPU out of the titlebar trigger', async () => {
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now())
  } as unknown as RepositoryApi

  render(<PerformanceHud />)
  openHud()

  await waitFor(() => expect(document.querySelector('.performance-memory strong')?.textContent).toBe('512 MB'))
  expect(document.querySelector('.performance-hud > summary')?.textContent).not.toMatch(/CPU|GPU/)
  expect(await screen.findByText('App CPU')).toBeTruthy()
})

test('closes when clicking outside or pressing Escape', async () => {
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now())
  } as unknown as RepositoryApi

  render(
    <div>
      <button type="button">outside</button>
      <PerformanceHud />
    </div>
  )

  const hud = (): HTMLDetailsElement => document.querySelector<HTMLDetailsElement>('.performance-hud')!
  fireEvent.click(hud().querySelector('summary')!)
  await waitFor(() => expect(hud().open).toBe(true))

  fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
  await waitFor(() => expect(hud().open).toBe(false))

  fireEvent.click(hud().querySelector('summary')!)
  await waitFor(() => expect(hud().open).toBe(true))

  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(hud().open).toBe(false))
})

test('asks main for nothing inside the launch window', async () => {
  let requestCount = 0
  window.repository = {
    getPerformanceMetrics: async () => {
      requestCount += 1
      return metrics(Date.now())
    }
  } as unknown as RepositoryApi

  render(<PerformanceHud />)

  // The prime waits for the reader's first input; nothing has been pressed yet.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  expect(requestCount).toBe(0)
  expect(document.querySelector('.performance-memory strong')?.textContent).toBe('')

  openHud()
  await waitFor(() => expect(requestCount).toBe(1))
})

test('primes the badge with one idle sample after the first input, then stays quiet', async () => {
  let requestCount = 0
  let idleCallback: IdleRequestCallback | null = null
  window.requestIdleCallback = ((callback: IdleRequestCallback) => {
    idleCallback = callback
    return 42
  }) as typeof window.requestIdleCallback
  window.cancelIdleCallback = (() => {}) as typeof window.cancelIdleCallback
  const realSetTimeout = window.setTimeout
  window.repository = {
    getPerformanceMetrics: async () => {
      requestCount += 1
      return metrics(Date.now())
    }
  } as unknown as RepositoryApi

  try {
    render(<PerformanceHud />)
    // The unsampled badge is neutral, not a warning.
    expect(document.querySelector('.performance-signal.idle')).toBeTruthy()

    // A launch shows its final frame: no reading lands until the reader moves.
    await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 25)) })
    expect(idleCallback).toBeNull()
    window.dispatchEvent(new Event('pointerdown'))
    await waitFor(() => expect(idleCallback).not.toBeNull())
    await act(async () => { idleCallback?.({ didTimeout: false, timeRemaining: () => 50 }) })

    await waitFor(() => expect(requestCount).toBe(1))
    expect(document.querySelector('.performance-memory strong')?.textContent).toBe('512 MB')
    expect(document.querySelector('.performance-signal.idle')).toBeNull()
    expect(document.querySelector('.performance-signal.production')).toBeTruthy()

    // Nobody is reading, so the interval loop never arms itself.
    await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 30)) })
    expect(requestCount).toBe(1)
  } finally {
    window.setTimeout = realSetTimeout
  }
})

test('waits for an idle callback before the first sample', async () => {
  let requestCount = 0
  let idleCallback: IdleRequestCallback | null = null
  window.requestIdleCallback = ((callback: IdleRequestCallback) => {
    idleCallback = callback
    return 42
  }) as typeof window.requestIdleCallback
  window.cancelIdleCallback = (() => {}) as typeof window.cancelIdleCallback
  window.repository = {
    getPerformanceMetrics: async () => {
      requestCount += 1
      return metrics(Date.now())
    }
  } as unknown as RepositoryApi

  render(<PerformanceHud />)
  openHud()

  const scheduled = idleCallback as IdleRequestCallback | null
  expect(scheduled).not.toBeNull()
  expect(requestCount).toBe(0)

  await act(async () => { scheduled?.({ didTimeout: false, timeRemaining: () => 50 }) })
  await waitFor(() => expect(requestCount).toBe(1))
})

test('cancels a pending idle sample when the hud unmounts', () => {
  const cancelled: number[] = []
  window.requestIdleCallback = (() => 42) as typeof window.requestIdleCallback
  window.cancelIdleCallback = ((handle: number) => { cancelled.push(handle) }) as typeof window.cancelIdleCallback
  window.repository = {
    getPerformanceMetrics: async () => metrics(Date.now())
  } as unknown as RepositoryApi

  const { unmount } = render(<PerformanceHud />)
  openHud()
  unmount()

  expect(cancelled).toEqual([42])
})
