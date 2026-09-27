import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { Fragment, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CodeViewItem, CodeViewLineSelection, SelectedLineRange } from '@pierre/diffs'
import type * as PierreReact from '@pierre/diffs/react'

import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'

// Pierre's viewer needs real layout, so a stand-in takes its place. What it keeps
// is the part these tests are about: `SlotPortals` rebuilds the portal of every
// rendered item whenever one of the slot render functions changes identity, and
// otherwise only when a rendered item's version does.
interface FakeCodeViewProps {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  options: PierreReact.CodeViewReactOptions<ReviewAnnotationMetadata>
  onSelectedLinesChange?(selection: CodeViewLineSelection | null): void
  renderHeaderPrefix(item: CodeViewItem<ReviewAnnotationMetadata>): React.ReactNode
  renderHeaderMetadata(item: CodeViewItem<ReviewAnnotationMetadata>): React.ReactNode
  renderAnnotation(annotation: unknown, item: CodeViewItem<ReviewAnnotationMetadata>): React.ReactNode
  renderGutterUtility(getHoveredLine: () => undefined, item: CodeViewItem<ReviewAnnotationMetadata>): React.ReactNode
}

const RENDERED_ITEMS = 20
const viewer = {
  props: null as FakeCodeViewProps | null,
  portalBuilds: 0
}

function FakeCodeView(props: FakeCodeViewProps): React.JSX.Element {
  viewer.props = props
  const hostsRef = useRef(new Map<string, HTMLElement>())
  const rendered = props.items.slice(0, RENDERED_ITEMS)
  let itemKeys = ''
  for (const item of rendered) itemKeys += `${item.id}:${item.version}`
  const { renderHeaderPrefix, renderHeaderMetadata, renderAnnotation, renderGutterUtility } = props
  const portals = useMemo(() => rendered.map((item) => {
    viewer.portalBuilds += 1
    let host = hostsRef.current.get(item.id)
    if (host == null) {
      host = document.createElement('div')
      document.body.append(host)
      hostsRef.current.set(item.id, host)
    }
    const annotations = (item as { annotations?: unknown[] }).annotations ?? []
    return createPortal(<>
      {renderHeaderPrefix(item)}
      {renderHeaderMetadata(item)}
      {annotations.map((annotation, index) => <Fragment key={index}>{renderAnnotation(annotation, item)}</Fragment>)}
      {renderGutterUtility(() => undefined, item)}
    </>, host, item.id)
  // The stand-in keys on exactly what Pierre's `SlotPortals` keys on.
  // oxlint-disable-next-line react/exhaustive-deps
  }), [renderHeaderPrefix, renderHeaderMetadata, renderAnnotation, renderGutterUtility, itemKeys])
  return <>{portals}</>
}

const realPierreReact = await import('@pierre/diffs/react')
mock.module('@pierre/diffs/react', () => ({ ...realPierreReact, CodeView: FakeCodeView }))

const { default: MultiFileReview } = await import('./MultiFileReview')
const { DEFAULT_PREFERENCES } = await import('../settings/preferences')

afterEach(() => {
  cleanup()
  viewer.props = null
  viewer.portalBuilds = 0
})

const ITEM_COUNT = 40
const THREAD_COUNT = 10
const noop = (): void => {}

function fixture() {
  const items: CodeViewItem<ReviewAnnotationMetadata>[] = []
  const threadsByPath: Record<string, ReviewThread[]> = {}
  const paths: string[] = []
  for (let index = 0; index < ITEM_COUNT; index += 1) {
    const path = `src/module${index}.ts`
    paths.push(path)
    items.push({
      id: `review:${path}`,
      type: 'diff',
      fileDiff: { name: path, type: 'change', hunks: [], additionLines: [], deletionLines: [], isPartial: false }
    } as unknown as CodeViewItem<ReviewAnnotationMetadata>)
    if (index < THREAD_COUNT) {
      threadsByPath[path] = [{
        id: `thread-${index}`,
        body: 'This branch never runs when the list is empty, so the fallback below is dead.',
        lineNumber: 12,
        side: 'additions',
        range: { start: 12, end: 12, side: 'additions' },
        replies: [{ id: `reply-${index}`, body: 'Good catch, removing it.' }],
        resolved: false
      }]
    }
  }
  return { items, threadsByPath, paths }
}

function renderReview(): { itemId: string } {
  const { items, threadsByPath, paths } = fixture()
  render(<MultiFileReview
    paths={paths} diffStyle="split" preferences={DEFAULT_PREFERENCES}
    loadState={{ items, loadedPaths: new Set(paths), omittedFiles: [], failedCount: 0, skippedCount: 0, paged: false }}
    loading={false} targetPathCount={paths.length} onLoadMore={noop}
    scrollToReviewRevision={0} navigationPath={null} navigationRevision={0} handledNavigationRevisionRef={{ current: 0 }}
    getInitialScrollTop={() => 0} onScrollPositionChange={noop} onVisiblePathChange={noop}
    threadsByPath={threadsByPath} setThreadsByPath={noop}
    viewedFiles={{}} setViewedFiles={noop}
    remoteThreadsByPath={new Map()} pendingRemoteThreadId={null}
    onReplyToRemoteThread={noop} onResolveRemoteThread={noop} onAttachToAgent={noop}
    reviewCommand={null} worldId="world-selection-test" />)
  return { itemId: items[2]!.id }
}

function slotIdentities() {
  const props = viewer.props!
  return [props.renderHeaderPrefix, props.renderHeaderMetadata, props.renderAnnotation, props.renderGutterUtility]
}

// What Pierre reports while the reader drags down the line numbers: one
// selection change per line crossed.
function dragAcrossLines(itemId: string, lines: number): number[] {
  const perLine: number[] = []
  for (let offset = 0; offset < lines; offset += 1) {
    const range: SelectedLineRange = { start: 10, end: 10 + offset, side: 'additions' }
    const startedAt = performance.now()
    act(() => viewer.props!.onSelectedLinesChange?.({ id: itemId, range }))
    perLine.push(performance.now() - startedAt)
  }
  return perLine
}

test('a line-number drag leaves the slot renderers and every item portal alone', () => {
  const { itemId } = renderReview()
  // The press itself goes from no selection to one line; what is measured is
  // every line the drag crosses after it.
  dragAcrossLines(itemId, 1)
  const slots = slotIdentities()
  const buildsBefore = viewer.portalBuilds

  const perLine = dragAcrossLines(itemId, 50)
  const sorted = [...perLine].sort((left, right) => left - right)
  // Wall clock is reported, not asserted; the portal count below is the gate.
  console.info(`selection drag: median ${sorted[25]!.toFixed(2)} ms, max ${sorted[49]!.toFixed(2)} ms per line, `
    + `${viewer.portalBuilds - buildsBefore} item portals rebuilt`)

  for (const [index, slot] of slotIdentities().entries()) expect(slot).toBe(slots[index]!)
  expect(viewer.portalBuilds - buildsBefore).toBe(0)
})

test('finishing a selection rebuilds the portals once, for the version it bumps', () => {
  const { itemId } = renderReview()
  const slots = slotIdentities()
  const buildsBefore = viewer.portalBuilds
  act(() => viewer.props!.options.onLineSelectionEnd?.(
    { start: 10, end: 14, side: 'additions' },
    { item: { id: itemId } } as never
  ))
  // The selection bar lands on one item, which bumps its version: one rebuild
  // of the rendered set, and the renderers themselves stay put.
  expect(viewer.portalBuilds - buildsBefore).toBe(RENDERED_ITEMS)
  for (const [index, slot] of slotIdentities().entries()) expect(slot).toBe(slots[index]!)
})
