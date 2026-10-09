import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import type { CodeView, CodeViewItem } from '@pierre/diffs'

import type { AgentRequestSubject, RepositoryApi } from '../../../shared/contracts'
import type { ReviewGuideReply, ReviewGuideRequest } from '../../../shared/reviewGuide'
import { reviewGuideHost } from '../review/reviewGuideView'
import { ReviewGuideView, type GuideViewerHandle } from './ReviewGuideView'
import { reviewGuideStore } from './reviewGuideStore'
import { testGuide } from './testGuide'

reviewGuideHost()

let world = 0
const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.test.ts']
const items = paths.map((path) => ({ id: `review:${path}`, type: 'file' }) as unknown as CodeViewItem<unknown>)

function fakeViewer(): { handle: GuideViewerHandle; scrollTo: ReturnType<typeof mock>; scroll(top: number): void; root: { scrollBy: ReturnType<typeof mock> } } {
  // Laid out in the guide's order, as the reordered review draws them.
  const tops = new Map(['src/b.ts', 'src/a.ts', 'src/c.ts', 'test/a.test.ts'].map((path, index) => [`review:${path}`, index * 1_000]))
  let listener: ((top: number) => void) | null = null
  const root = { scrollTop: 0, scrollHeight: 10_000, clientHeight: 800, scrollBy: mock((_options: ScrollToOptions) => {}) }
  const instance = {
    root,
    getRenderedItems: () => items,
    getTopForItem: (id: string) => tops.get(id),
    subscribeToScroll: (next: (top: number) => void) => { listener = next; return () => { listener = null } }
  } as unknown as CodeView<unknown>
  const scrollTo = mock((_target: unknown) => {})
  return {
    handle: { getInstance: () => instance, scrollTo, setSelectedLines: () => {}, getItem: (id) => tops.has(id) ? {} : undefined },
    scrollTo,
    root,
    scroll(top: number) { root.scrollTop = top; listener?.(top) }
  }
}

function setup(reply: ReviewGuideReply): { worldId: string; viewer: ReturnType<typeof fakeViewer>; getReviewGuide: ReturnType<typeof mock> } {
  const worldId = `desk:/guide-${++world}`
  const subject = { tabId: worldId, repositoryRoot: '/repo', source: 'workingTree' } as AgentRequestSubject
  const getReviewGuide = mock(async (_request: ReviewGuideRequest) => reply)
  window.repository = {
    getReviewGuide,
    cancelReviewGuide: async () => {},
    onReviewGuideProgress: () => () => {},
    onDidChange: () => () => {}
  } as unknown as RepositoryApi
  reviewGuideHost().setAgent({
    subject, provider: 'codex', model: 'gpt-test', effort: 'default', models: [], login: () => {}, openAgent: () => {}
  })
  reviewGuideHost().setView(worldId, 'guide')
  const viewer = fakeViewer()
  const ref = createRef<GuideViewerHandle | null>() as { current: GuideViewerHandle | null }
  ref.current = viewer.handle
  render(<ReviewGuideView worldId={worldId} viewerRef={ref} items={items} viewedPaths={new Set(['src/a.ts'])}
    repositoryReview={null} fileCount={4} />)
  return { worldId, viewer, getReviewGuide }
}

afterEach(() => {
  cleanup()
  delete window.repository
})

describe('ReviewGuideView', () => {
  test('Generate offers the model, effort, focus and the account it runs as', async () => {
    setup({ status: 'unavailable', reason: 'none', code: 'not-cached' })
    const repository = window.repository as unknown as Record<string, unknown>
    repository.getAgentModels = async () => ({ claude: [], codex: [{ id: 'gpt-test', label: 'GPT Test', description: '', efforts: ['low', 'high'], defaultEffort: 'low' }] })
    repository.getAgentStatuses = async () => ({
      claude: { provider: 'claude', installed: true, authenticated: false, label: '', detail: '' },
      codex: { provider: 'codex', installed: true, authenticated: true, label: '', detail: '', account: { email: 'reader@example.com', plan: 'pro' } }
    })
    await act(async () => {})
    expect(document.querySelector('#guide-agent-provider')).not.toBeNull()
    expect(document.querySelector('#guide-agent-model')).not.toBeNull()
    expect(document.querySelector('#guide-agent-effort')).not.toBeNull()
    expect(document.querySelector('#guide-agent-instructions')).not.toBeNull()
  })

  test('with nothing stored it offers Generate, asking the disk only', async () => {
    const { getReviewGuide } = setup({ status: 'unavailable', reason: 'none', code: 'not-cached' })
    await act(async () => {})
    expect(getReviewGuide).toHaveBeenCalledTimes(1)
    expect(getReviewGuide.mock.calls[0]![0]).toMatchObject({ cachedOnly: true })
    expect(screen.getByText('Generate a guide for this review')).toBeTruthy()
  })

  test('a stored guide shows its header, the first section and reorders the review', async () => {
    const { worldId } = setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Teach the parser comments')
    expect(document.querySelector('[data-guide-counter]')?.textContent).toBe('01 / 02')
    expect([...document.querySelectorAll('[data-guide-file]')].map((row) => row.getAttribute('data-guide-file')))
      .toEqual(['src/b.ts', 'src/a.ts'])
    expect(document.querySelector('[data-guide-file="src/a.ts"] [aria-label="viewed"]')).not.toBeNull()
    expect([...reviewGuideHost().order(worldId)!.rank.keys()]).toEqual([
      'review:src/b.ts', 'review:src/a.ts', 'review:src/c.ts', 'review:test/a.test.ts'
    ])
    expect([...document.querySelectorAll('[data-guide-step]')].map((step) => step.hasAttribute('data-active'))).toEqual([true, false, false])
  })

  test('the column follows the file being read, and a row scrolls to its file', async () => {
    const { viewer } = setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    await act(async () => {
      viewer.scroll(2_000)
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(document.querySelector('[data-guide-counter]')?.textContent).toBe('02 / 02')
    const repeat = document.querySelector('[data-guide-file="src/b.ts"]')!
    expect(repeat.textContent).toContain('01')
    fireEvent.click(document.querySelector('[data-guide-file="src/c.ts"]')!)
    expect(viewer.scrollTo.mock.calls.at(-1)![0]).toMatchObject({ type: 'item', id: 'review:src/c.ts' })
  })

  test('a wheel over the walkthrough scrolls the review, and a step opens its section', async () => {
    const { viewer } = setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    const column = document.querySelector('[data-guide-column]')!
    fireEvent.wheel(column, { deltaY: 120, deltaMode: 0 })
    expect(viewer.root.scrollBy.mock.calls.at(-1)![0]).toMatchObject({ top: 120 })
    fireEvent.click(document.querySelectorAll('[data-guide-step] .guide-step-head')[1]!)
    expect(viewer.scrollTo.mock.calls.at(-1)![0]).toMatchObject({ type: 'item', id: 'review:src/c.ts' })
  })

  test('} and { move by section, ] by file in guide order', async () => {
    const { viewer } = setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    fireEvent.keyDown(window, { code: 'BracketRight', key: '}', shiftKey: true })
    expect(viewer.scrollTo.mock.calls.at(-1)![0]).toMatchObject({ id: 'review:src/c.ts' })
    fireEvent.keyDown(window, { code: 'BracketRight', key: ']' })
    expect(viewer.scrollTo.mock.calls.at(-1)![0]).toMatchObject({ id: 'review:src/a.ts' })
  })

  test('Copy guide as Markdown writes the guide to the clipboard', async () => {
    const writeText = mock(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    fireEvent.click(screen.getByLabelText('Guide actions'))
    fireEvent.click(screen.getByText('Copy guide as Markdown'))
    expect(writeText.mock.calls[0]![0]).toStartWith('# Teach the parser comments\n')
  })

  test('Regenerate forces a new run', async () => {
    const { getReviewGuide, worldId } = setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    await act(async () => { fireEvent.click(screen.getByText('Regenerate')) })
    expect(getReviewGuide.mock.calls.at(-1)![0]).toMatchObject({ force: true })
    expect(reviewGuideStore.get(worldId).status).toBe('ready')
  })

  test('the walkthrough column resizes from its edge and keeps the width', async () => {
    setup({ status: 'ready', guide: testGuide(), cached: true })
    await act(async () => {})
    const handle = document.querySelector<HTMLElement>('[data-guide-resizer]')!
    const column = document.querySelector<HTMLElement>('[data-guide-column]')!
    const before = Number.parseInt(column.style.width, 10)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(Number.parseInt(column.style.width, 10)).toBe(before + 16)
    expect(localStorage.getItem('kodi:guide-column-width')).toBe(String(before + 16))
    fireEvent.doubleClick(handle)
    expect(column.style.width).toBe('296px')
  })
})
