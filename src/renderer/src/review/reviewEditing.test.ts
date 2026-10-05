import { describe, expect, test } from 'bun:test'
import type { FileDiffMetadata } from '@pierre/diffs'

import type { FileComparison } from '../../../shared/contracts'
import { editCaretPosition } from './reviewCaret'
import { editableReviewDiff } from './reviewEditActions'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import { createPatchReviewItems } from './reviewItems'
import { applyReviewEdits, isEditableReviewItem, type ReviewEdit } from './useReviewEditing'

const OLD = Array.from({ length: 30 }, (_unused, line) => `line ${line}\n`).join('')
const NEW = OLD.replace('line 14\n', 'line 14 changed\n')
const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -12,7 +12,7 @@',
  ' line 11',
  ' line 12',
  ' line 13',
  '-line 14',
  '+line 14 changed',
  ' line 15',
  ' line 16',
  ' line 17',
  ''
].join('\n')

function comparison(newContents = NEW): FileComparison {
  return {
    path: 'src/app.ts',
    mode: 'diff',
    status: 'modified',
    oldFile: { name: 'src/app.ts', contents: OLD, cacheKey: 'old' },
    newFile: { name: 'src/app.ts', contents: newContents, cacheKey: 'new' },
    binary: false,
    oversized: false
  }
}

function patchItem() {
  const [item] = createPatchReviewItems<ReviewAnnotationMetadata>(PATCH, 'v1')
  if (item?.type !== 'diff') throw new Error('expected a diff item')
  return item
}

describe('editableReviewDiff', () => {
  test('a patch is made whole from the disk copy, both sides', async () => {
    const item = patchItem()
    expect(item.fileDiff.isPartial).toBe(true)
    const whole = await editableReviewDiff(item.fileDiff, comparison(), undefined)
    expect(whole.isPartial).toBe(false)
    expect(whole.additionLines.join('')).toBe(NEW)
    expect(whole.deletionLines.join('')).toBe(OLD)
  })

  test('a draft is the new side as it was left', async () => {
    const draft = NEW.replace('line 20\n', 'line 20 typed\n')
    const whole = await editableReviewDiff(patchItem().fileDiff, comparison(), draft)
    expect(whole.additionLines.join('')).toBe(draft)
  })

  test('a patch the disk no longer matches is worked out again from the disk', async () => {
    const moved = NEW.replace('line 3\n', 'line 3 elsewhere\n')
    const whole = await editableReviewDiff(patchItem().fileDiff, comparison(moved), undefined)
    expect(whole.additionLines.join('')).toBe(moved)
  })
})

describe('applyReviewEdits', () => {
  test('only the edited file is swapped, and the same edit keeps the same item', async () => {
    const item = patchItem()
    const other = { ...item, id: `${item.id}-other` }
    const fileDiff: FileDiffMetadata = await editableReviewDiff(item.fileDiff, comparison(), undefined)
    const edit: ReviewEdit = { fileDiff, sourceCacheKey: 'new', sourceContents: NEW, dirty: false, saving: false }
    const edits = new Map([['src/app.ts', edit]])
    const once = applyReviewEdits([item, other], edits)
    expect(once[0]).not.toBe(item)
    expect(once[0]).toMatchObject({ edit: true, fileDiff })
    expect(once[1]).toBe(other)
    // Turning dirty is not a new session: the viewer must not be handed the file again.
    const dirty = applyReviewEdits([item, other], new Map([['src/app.ts', { ...edit, dirty: true }]]))
    expect(dirty[0]).toBe(once[0])
    expect(applyReviewEdits([item, other], new Map())).toEqual([item, other])
  })

  test('a deleted file or a folded one is not offered', () => {
    const item = patchItem()
    expect(isEditableReviewItem(item)).toBe(true)
    expect(isEditableReviewItem({ ...item, collapsed: true })).toBe(false)
    expect(isEditableReviewItem({ ...item, fileDiff: { ...item.fileDiff, type: 'deleted' } })).toBe(false)
  })
})

describe('editCaretPosition', () => {
  function line(attributes: Record<string, string>, text: string, column?: 'data-deletions' | 'data-additions') {
    const code = document.createElement('code')
    if (column != null) code.setAttribute(column, '')
    const element = document.createElement('div')
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
    const node = document.createTextNode(text)
    element.append(node)
    code.append(element)
    document.body.append(code)
    const range = document.createRange()
    range.setStart(node, 4)
    return { element, range }
  }

  test('a line of the new file places the caret on it', () => {
    const { element, range } = line({ 'data-line': '15', 'data-line-type': 'change-addition' }, 'line 14 changed')
    expect(editCaretPosition(element, range)).toEqual({ lineNumber: 15, character: 4 })
  })

  test('a context line in the old column is placed by its new-file number', () => {
    const { element, range } = line({ 'data-line': '12', 'data-alt-line': '14', 'data-line-type': 'context' }, 'line 13', 'data-deletions')
    expect(editCaretPosition(element, range)).toEqual({ lineNumber: 14, character: 4 })
  })

  test('a deleted line is old text and places nothing', () => {
    const { element, range } = line({ 'data-line': '15', 'data-line-type': 'change-deletion' }, 'line 14')
    expect(editCaretPosition(element, range)).toBeNull()
  })
})
