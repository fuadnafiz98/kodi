import { expect, test } from 'bun:test'

import { annotationLine, selectedRangeLastLine } from './reviewAnnotations'
import type { ReviewThread } from './ReviewComments'

const range = { start: 50, end: 54, side: 'additions' as const }

function thread(lineNumber: number): ReviewThread {
  return {
    id: 'thread-1',
    body: 'What is this?',
    lineNumber,
    side: 'additions',
    range,
    replies: [],
    resolved: false
  }
}

test('selectedRangeLastLine follows the later end when a drag reports the origin first', () => {
  expect(selectedRangeLastLine({ start: 54, end: 50 })).toBe(54)
  expect(selectedRangeLastLine(range)).toBe(54)
})

test('selection and draft annotations sit after the last dragged line', () => {
  expect(annotationLine({ kind: 'selection', range: { start: 54, end: 50, side: 'additions' } })).toBe(54)
  expect(annotationLine({ kind: 'draft', range })).toBe(54)
})

test('a saved thread that still stores the drag origin sits after the last selected line', () => {
  expect(annotationLine({ kind: 'thread', thread: thread(50) })).toBe(54)
})

test('an editor-remapped thread keeps the remapped line when it leaves the original span', () => {
  expect(annotationLine({ kind: 'thread', thread: thread(60) })).toBe(60)
})
