import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@pierre/diffs/edit'

import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import { EMPTY_CARET, readCaret, type CaretReadout } from './caret'

/**
 * Line, column and selection size for the status bar. `selectionchange` fires
 * far more often than the readout can change, so every burst collapses into one
 * frame and an unchanged readout keeps its identity.
 */
export function useCaretReadout(
  editing: boolean,
  getEditor: () => Editor<ReviewAnnotationMetadata> | null
): CaretReadout {
  const [caret, setCaret] = useState<CaretReadout>(EMPTY_CARET)
  const frameRef = useRef<number | null>(null)

  const sampleCaret = useCallback(() => {
    frameRef.current = null
    setCaret((current) => {
      const next = readCaret(getEditor())
      return next.line === current.line
        && next.column === current.column
        && next.selectedLines === current.selectedLines
        && next.selectedCharacters === current.selectedCharacters
        ? current
        : next
    })
  }, [getEditor])

  useEffect(() => {
    if (!editing) {
      setCaret(EMPTY_CARET)
      return
    }
    const schedule = (): void => {
      if (frameRef.current != null) return
      frameRef.current = window.requestAnimationFrame(sampleCaret)
    }
    document.addEventListener('selectionchange', schedule)
    schedule()
    return () => {
      document.removeEventListener('selectionchange', schedule)
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [editing, sampleCaret])

  return caret
}
