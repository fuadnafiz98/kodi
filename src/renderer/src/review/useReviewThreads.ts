import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { CodeViewItem, CodeViewLineSelection, SelectedLineRange } from '@pierre/diffs'

import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { selectedRangeLastLine } from './reviewAnnotations'
import { pathFromReviewItemId as pathFromItemId } from './reviewItems'
import {
  attachReviewThreadToRange,
  createReviewCommentAnchor
} from './reviewThreadAnchors'
import { worldViewCache } from './worldViewCache'

export interface DraftReviewComment {
  path: string
  range: SelectedLineRange
}

export type UpdateReviewThread = (
  path: string,
  threadId: string,
  update: (thread: ReviewThread) => ReviewThread | null
) => void

function incrementItemVersions(
  current: Readonly<Record<string, number>>,
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
): Record<string, number> {
  const next = { ...current }
  for (const item of items) {
    const path = pathFromItemId(item.id)
    next[path] = (next[path] ?? 0) + 1
  }
  return next
}

interface ReviewThreadsOptions {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  threadsByPath: Readonly<Record<string, ReviewThread[]>>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  worldId?: string | null
}

export interface ReattachingReviewThread {
  path: string
  threadId: string
}

interface ReviewThreadsApi {
  selectedLines: CodeViewLineSelection | null
  draftComment: DraftReviewComment | null
  annotationVersions: Readonly<Record<string, number>>
  collapsedItemIds: ReadonlySet<string>
  bumpPathVersions(paths: readonly string[]): void
  toggleItemCollapsed(item: CodeViewItem<ReviewAnnotationMetadata>): void
  toggleCollapsedById(itemId: string): void
  setCollapsedById(itemId: string, collapsed: boolean): void
  collapseAllFiles(): void
  expandAllFiles(): void
  beginComment(selection: CodeViewLineSelection): void
  handleSelectedLinesChange(selection: CodeViewLineSelection | null): void
  saveComment(body: string): void
  cancelComment(): void
  reattachingThread: ReattachingReviewThread | null
  beginReattach(path: string, threadId: string): void
  cancelReattach(): void
  reattachToSelection(selection: CodeViewLineSelection): boolean
  updateThread: UpdateReviewThread
}

export function useReviewThreads({
  items,
  threadsByPath,
  setThreadsByPath,
  worldId = null
}: ReviewThreadsOptions): ReviewThreadsApi {
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null)
  const [draftComment, setDraftComment] = useState<DraftReviewComment | null>(null)
  const [annotationVersions, setAnnotationVersions] = useState<Record<string, number>>({})
  const [collapsedItemIds, setCollapsedItemIds] = useState<Set<string>>(() => new Set())
  const [reattachingThread, setReattachingThread] = useState<ReattachingReviewThread | null>(null)
  const [activeWorldId, setActiveWorldId] = useState(worldId)
  if (activeWorldId !== worldId) {
    if (activeWorldId != null) worldViewCache.rememberCollapsed(activeWorldId, collapsedItemIds)
    setActiveWorldId(worldId)
    const cachedCollapsed = worldId == null ? null : worldViewCache.get(worldId)?.collapsedItemIds
    setCollapsedItemIds(cachedCollapsed instanceof Set ? cachedCollapsed : new Set(cachedCollapsed))
    setSelectedLines(null)
    setDraftComment(null)
    setReattachingThread(null)
    setAnnotationVersions((current) =>
      Object.keys(current).length === 0 ? current : {}
    )
  }

  const bumpAnnotationVersion = useCallback((path: string) => {
    setAnnotationVersions((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1
    }))
  }, [])

  const bumpPathVersions = useCallback((paths: readonly string[]) => {
    setAnnotationVersions((current) => {
      const next = { ...current }
      for (const path of paths) next[path] = (next[path] ?? 0) + 1
      return next
    })
  }, [])

  const toggleCollapsedById = useCallback((itemId: string) => {
    setCollapsedItemIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
    bumpAnnotationVersion(pathFromItemId(itemId))
  }, [bumpAnnotationVersion])

  const setCollapsedById = useCallback((itemId: string, collapsed: boolean) => {
    setCollapsedItemIds((current) => {
      if (current.has(itemId) === collapsed) return current
      const next = new Set(current)
      if (collapsed) next.add(itemId)
      else next.delete(itemId)
      return next
    })
    bumpAnnotationVersion(pathFromItemId(itemId))
  }, [bumpAnnotationVersion])

  const toggleItemCollapsed = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    toggleCollapsedById(item.id)
  }, [toggleCollapsedById])

  const collapseAllFiles = useCallback(() => {
    setCollapsedItemIds(new Set(items.map((item) => item.id)))
    setAnnotationVersions((current) => incrementItemVersions(current, items))
  }, [items])

  const expandAllFiles = useCallback(() => {
    setCollapsedItemIds(new Set())
    setAnnotationVersions((current) => incrementItemVersions(current, items))
  }, [items])

  const beginComment = useCallback((selection: CodeViewLineSelection) => {
    setSelectedLines(selection)
    setDraftComment({ path: pathFromItemId(selection.id), range: selection.range })
  }, [])

  const handleSelectedLinesChange = useCallback((selection: CodeViewLineSelection | null) => {
    setSelectedLines(selection)
  }, [])

  const saveComment = useCallback((body: string) => {
    if (draftComment == null) return
    const item = items.find((candidate) => pathFromItemId(candidate.id) === draftComment.path)
    const anchor = item == null ? null : createReviewCommentAnchor(item, draftComment.range)
    const thread: ReviewThread = {
      id: crypto.randomUUID(),
      body,
      lineNumber: selectedRangeLastLine(draftComment.range),
      side: draftComment.range.side,
      range: draftComment.range,
      ...(anchor == null ? {} : { anchor }),
      replies: [],
      resolved: false
    }
    setThreadsByPath((current) => ({
      ...current,
      [draftComment.path]: [...(current[draftComment.path] ?? []), thread]
    }))
    bumpAnnotationVersion(draftComment.path)
    setDraftComment(null)
  }, [bumpAnnotationVersion, draftComment, items, setThreadsByPath])

  const cancelComment = useCallback(() => {
    setDraftComment(null)
    setSelectedLines(null)
  }, [])

  const beginReattach = useCallback((path: string, threadId: string) => {
    setReattachingThread({ path, threadId })
    setDraftComment(null)
    setSelectedLines(null)
  }, [])

  const cancelReattach = useCallback(() => {
    setReattachingThread(null)
    setSelectedLines(null)
  }, [])

  const reattachToSelection = useCallback((selection: CodeViewLineSelection): boolean => {
    if (reattachingThread == null) return false
    const destinationPath = pathFromItemId(selection.id)
    const item = items.find((candidate) => candidate.id === selection.id)
    const thread = threadsByPath[reattachingThread.path]?.find(
      (candidate) => candidate.id === reattachingThread.threadId
    )
    if (item == null || thread == null) return false
    const attached = attachReviewThreadToRange(thread, item, selection.range)
    if (attached == null) return false
    setThreadsByPath((current) => {
      const sourceThreads = (current[reattachingThread.path] ?? []).filter(
        (candidate) => candidate.id !== reattachingThread.threadId
      )
      if (destinationPath === reattachingThread.path) {
        return { ...current, [destinationPath]: [...sourceThreads, attached] }
      }
      return {
        ...current,
        [reattachingThread.path]: sourceThreads,
        [destinationPath]: [...(current[destinationPath] ?? []), attached]
      }
    })
    bumpPathVersions(reattachingThread.path === destinationPath
      ? [destinationPath]
      : [reattachingThread.path, destinationPath])
    setReattachingThread(null)
    setSelectedLines(null)
    return true
  }, [bumpPathVersions, items, reattachingThread, setThreadsByPath, threadsByPath])

  const updateThread = useCallback<UpdateReviewThread>((path, threadId, update) => {
    setThreadsByPath((current) => ({
      ...current,
      [path]: (current[path] ?? []).flatMap((thread) => {
        if (thread.id !== threadId) return [thread]
        const nextThread = update(thread)
        return nextThread == null ? [] : [nextThread]
      })
    }))
    bumpAnnotationVersion(path)
  }, [bumpAnnotationVersion, setThreadsByPath])

  useEffect(() => {
    if (worldId == null) return
    worldViewCache.rememberCollapsed(worldId, collapsedItemIds)
  }, [collapsedItemIds, worldId])

  return {
    selectedLines,
    draftComment,
    annotationVersions,
    collapsedItemIds,
    bumpPathVersions,
    toggleItemCollapsed,
    toggleCollapsedById,
    setCollapsedById,
    collapseAllFiles,
    expandAllFiles,
    beginComment,
    handleSelectedLinesChange,
    saveComment,
    cancelComment,
    reattachingThread,
    beginReattach,
    cancelReattach,
    reattachToSelection,
    updateThread
  }
}
