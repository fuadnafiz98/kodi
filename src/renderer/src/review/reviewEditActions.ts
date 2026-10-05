import {
  hydratePartialDiff,
  parseDiffFromFile,
  type FileDiffMetadata
} from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'

import type { FileComparison } from '../../../shared/contracts'
import type { EditCaretPosition } from '../app/AppView'
import { preloadDiffEditor } from '../diff/useFileEditing'
import { minimalTextEdit } from '../editor/minimalTextEdit'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { loadPartialDiffFiles } from './partialDiffHydration'
import { createExactScroller } from './retainedWorldCodeView'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import { pathFromReviewItemId, reviewItemId } from './reviewItems'
import {
  isEditableReviewItem,
  updateEdit,
  type ReviewEdit,
  type ReviewEditContext,
  type ReviewEdits,
  type ReviewItem
} from './useReviewEditing'

// What a review file needs once someone starts typing in it — the whole-file
// diff, the save, the caret — loaded with the editor module rather than with the
// review, which only ever reads until a click asks for more.

interface PrimeableInstance {
  primeHighlightCache?(fileDiff?: FileDiffMetadata): Promise<void>
}

/**
 * The diff an editor can type into: every line of both files. A draft is the
 * new side as it was left; otherwise the reviewed diff is reused as it is when
 * it is already whole and still the file on disk, hydrated from the disk copy
 * when it is a patch, and recomputed only when the patch no longer matches.
 */
export async function editableReviewDiff(
  fileDiff: FileDiffMetadata,
  comparison: FileComparison,
  draft: string | undefined
): Promise<FileDiffMetadata> {
  const newFile = comparison.newFile!
  if (draft != null && draft !== newFile.contents) {
    return parseDiffFromFile(comparison.oldFile, { ...newFile, contents: draft, cacheKey: `${newFile.cacheKey}:draft` })
  }
  if (!fileDiff.isPartial) {
    return fileDiff.additionLines.join('') === newFile.contents ? fileDiff : parseDiffFromFile(comparison.oldFile, newFile)
  }
  try {
    const files = await loadPartialDiffFiles(fileDiff, [
      { side: 'new', load: async () => newFile },
      { side: 'old', load: async () => comparison.oldFile }
    ])
    return hydratePartialDiff('clone', fileDiff, files)
  } catch {
    return parseDiffFromFile(comparison.oldFile, newFile)
  }
}

/** Starting a file lets go of every other editor with nothing unsaved in it. */
function withStartedEdit(edits: ReviewEdits, path: string, started: ReviewEdit): ReviewEdits {
  if (edits.has(path)) return edits
  return new Map([...[...edits].filter(([, edit]) => edit.dirty || edit.saving), [path, started]])
}

export async function startReviewEdit(
  context: ReviewEditContext,
  item: ReviewItem,
  instance: unknown,
  position: EditCaretPosition | null
): Promise<void> {
  if (!isEditableReviewItem(item)) return
  const path = pathFromReviewItemId(item.id)
  if (context.editsRef.current.has(path) || context.startingRef.current.has(path)) return
  context.startingRef.current.add(path)
  context.pendingCaretRef.current = position == null ? null : { path, position }
  context.activePathRef.current = path
  try {
    const [comparison] = await Promise.all([requireRepositoryApi().getComparison(path), preloadDiffEditor()])
    const newFile = comparison.newFile
    if (newFile == null || comparison.binary || comparison.oversized) return
    const fileDiff = await editableReviewDiff(item.fileDiff, comparison, context.workingDrafts.get(path, newFile.cacheKey))
    // A diff the viewer has not highlighted flashes as plain text when it is
    // swapped in; highlighting it first makes the swap a cache hit.
    if (fileDiff !== item.fileDiff) await (instance as PrimeableInstance).primeHighlightCache?.(fileDiff)
    const sourceContents = newFile.contents
    const text = fileDiff.additionLines.join('')
    context.latestTextRef.current.set(path, text)
    const edit: ReviewEdit = { fileDiff, sourceCacheKey: newFile.cacheKey, sourceContents, dirty: text !== sourceContents, saving: false }
    context.setEdits((current) => withStartedEdit(current, path, edit))
  } catch (error) {
    context.onError(getErrorMessage(error))
  } finally {
    context.startingRef.current.delete(path)
  }
}

export async function saveReviewEdit(context: ReviewEditContext, path: string): Promise<void> {
  const edit = context.editsRef.current.get(path)
  if (edit == null || !edit.dirty || edit.saving) return
  const editor = context.viewerRef.current?.getEditor(reviewItemId(path)) as Editor<ReviewAnnotationMetadata> | undefined
  const contents = context.latestTextRef.current.get(path) ?? editor?.getText() ?? edit.sourceContents
  context.setEdits((current) => updateEdit(current, path, { saving: true }))
  context.onError(null)
  try {
    const saved = await context.workingDrafts.save(path, contents, edit.sourceCacheKey)
    context.setEdits((current) => updateEdit(current, path, {
      sourceCacheKey: saved.newFile?.cacheKey ?? edit.sourceCacheKey,
      sourceContents: contents,
      // Typing that went on while the write was out is still unsaved.
      dirty: (context.latestTextRef.current.get(path) ?? contents) !== contents,
      saving: false
    }))
  } catch (error) {
    context.onError(getErrorMessage(error))
    context.setEdits((current) => updateEdit(current, path, { saving: false }))
  }
}

/**
 * A write from outside — an agent, a formatter, a checkout — under a file whose
 * editor is open but untouched. The editor keeps the document it was handed
 * whatever the review refetches, so the review went on drawing the old text
 * over the new file. A clean session ends and the review shows the disk; the
 * next click edits the new text, as in the single-file view. A session with
 * typing in it keeps its draft: its save asserts the revision it started from,
 * and that save is refused rather than written over the new file.
 */
export async function adoptOutsideWrites(context: ReviewEditContext, paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    const edit = context.editsRef.current.get(path)
    if (edit == null || edit.dirty || edit.saving) return
    const comparison = await requireRepositoryApi().getComparison(path).catch(() => null)
    const current = context.editsRef.current.get(path)
    if (current !== edit && (current == null || current.dirty || current.saving || current.sourceCacheKey !== edit.sourceCacheKey)) return
    if (comparison?.newFile?.cacheKey === edit.sourceCacheKey) return
    context.latestTextRef.current.delete(path)
    context.setEdits((edits) => {
      const now = edits.get(path)
      if (now == null || now.dirty || now.saving) return edits
      const next = new Map(edits)
      next.delete(path)
      return next
    })
  }))
}

/** Back to the disk copy through the editor, so ⌘Z brings the draft back. */
export function discardReviewEdit(context: ReviewEditContext, path: string): void {
  const edit = context.editsRef.current.get(path)
  const editor = context.viewerRef.current?.getEditor(reviewItemId(path)) as Editor<ReviewAnnotationMetadata> | undefined
  if (edit == null || editor == null || !edit.dirty) return
  // Only what was typed goes back, so the caret stays where the change was.
  const revert = minimalTextEdit(editor.getText(), edit.sourceContents)
  if (revert != null) editor.applyEdits([revert])
}

// The caret goes where the click was, and the list stays exactly where it is:
// should revealing the line move the list at all, it is put straight back.
export function focusReviewEditor(context: ReviewEditContext, editor: Editor<ReviewAnnotationMetadata>): void {
  const pending = context.pendingCaretRef.current
  if (pending == null || context.viewerRef.current?.getEditor(reviewItemId(pending.path)) !== editor) return
  context.pendingCaretRef.current = null
  window.requestAnimationFrame(() => {
    const instance = context.viewerRef.current?.getInstance()
    const scrollTop = instance?.getScrollTop()
    editor.focus({ ...pending.position, preventScroll: true })
    const viewer = context.viewerRef.current
    if (scrollTop == null || instance == null || viewer == null || instance.getScrollTop() === scrollTop) return
    // A position scroll lands short of a sticky header; two passes are exact.
    const scrollExactly = createExactScroller()
    scrollExactly(viewer, scrollTop, null)
    scrollExactly(viewer, scrollTop, instance.getScrollTop())
  })
}
