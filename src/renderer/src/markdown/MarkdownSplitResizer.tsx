import { memo, useCallback, useRef, useState } from 'react'

import { clampSplitPercentage, resistedSplitPercentage } from '../diff/splitDiffResize'

const DEFAULT_SPLIT_PERCENT = 50
const MIN_SPLIT_PERCENT = 25
const MAX_SPLIT_PERCENT = 75
const KEYBOARD_STEP = 2
const LARGE_KEYBOARD_STEP = 10

function getSplit(resizer: HTMLDivElement): HTMLDivElement | null {
  const parent = resizer.parentElement
  if (!(parent instanceof HTMLDivElement) || !parent.classList.contains('markdown-split')) {
    return null
  }
  return parent
}

function applyPercentage(split: HTMLDivElement, shown: number): void {
  split.style.setProperty('--markdown-split-before', `${shown}fr`)
  split.style.setProperty('--markdown-split-after', `${100 - shown}fr`)
}

export const MarkdownSplitResizer = memo(function MarkdownSplitResizer(): React.JSX.Element {
  const resizerRef = useRef<HTMLDivElement>(null)
  const [percentage, setPercentage] = useState(DEFAULT_SPLIT_PERCENT)
  const livePercentageRef = useRef(percentage)
  const dragRef = useRef<{ clientX: number; percentage: number; width: number } | null>(null)

  const commitPercentage = useCallback((value: number) => {
    const next = clampSplitPercentage(value)
    livePercentageRef.current = next
    setPercentage(next)
    const split = resizerRef.current == null ? null : getSplit(resizerRef.current)
    if (split == null) return
    applyPercentage(split, next)
  }, [])

  const resizeFromPointer = useCallback((resizer: HTMLDivElement, clientX: number) => {
    const split = getSplit(resizer)
    const drag = dragRef.current
    if (split == null || drag == null) return
    const raw = drag.percentage + ((clientX - drag.clientX) / drag.width) * 100
    livePercentageRef.current = clampSplitPercentage(raw)
    applyPercentage(split, resistedSplitPercentage(raw, drag.width))
  }, [])

  const endDrag = useCallback((resizer: HTMLDivElement) => {
    if (dragRef.current == null) return
    dragRef.current = null
    const split = getSplit(resizer)
    if (split == null) return
    delete split.dataset.resizing
    applyPercentage(split, livePercentageRef.current)
    commitPercentage(livePercentageRef.current)
  }, [commitPercentage])

  return (
    <div
      ref={resizerRef}
      className="markdown-split-resizer"
      role="separator"
      aria-label="Resize source and preview"
      aria-orientation="vertical"
      aria-valuemin={MIN_SPLIT_PERCENT}
      aria-valuemax={MAX_SPLIT_PERCENT}
      aria-valuenow={Math.round(percentage)}
      title="Drag to resize · Double-click to reset"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const split = getSplit(event.currentTarget)
        if (split == null) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        split.dataset.resizing = ''
        dragRef.current = {
          clientX: event.clientX,
          percentage: livePercentageRef.current,
          width: split.getBoundingClientRect().width
        }
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        resizeFromPointer(event.currentTarget, event.clientX)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        endDrag(event.currentTarget)
      }}
      onPointerCancel={(event) => endDrag(event.currentTarget)}
      onLostPointerCapture={(event) => endDrag(event.currentTarget)}
      onDoubleClick={() => {
        dragRef.current = null
        commitPercentage(DEFAULT_SPLIT_PERCENT)
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? LARGE_KEYBOARD_STEP : KEYBOARD_STEP
        const next = event.key === 'ArrowLeft'
          ? livePercentageRef.current - step
          : event.key === 'ArrowRight'
            ? livePercentageRef.current + step
            : event.key === 'Home'
              ? MIN_SPLIT_PERCENT
              : event.key === 'End'
                ? MAX_SPLIT_PERCENT
                : event.key === 'Enter'
                  ? DEFAULT_SPLIT_PERCENT
                  : null
        if (next == null) return
        event.preventDefault()
        commitPercentage(next)
      }}
    />
  )
})
