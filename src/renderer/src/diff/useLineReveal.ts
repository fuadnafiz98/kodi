import { useCallback, useLayoutEffect, useRef } from 'react'
import type { SelectedLineRange } from '@pierre/diffs'

import { pendingReveal, takeReveal, useRevealRevision } from '../app/revealLocation'

interface LinePositioned {
  getLinePosition?(lineNumber: number, side?: 'additions' | 'deletions'): { top: number } | undefined
}

// The line lands a third of the way down, where the eye goes after a jump,
// with the lines that lead up to it still in view.
const REVEAL_FROM_TOP = 1 / 3

/**
 * Takes a line asked for in the palette (`src/app.ts:42`) once the file that
 * holds it has rendered: scrolls it into view and selects it. Returns the
 * callback the viewer's post-render hook reports each render to.
 */
export function useLineReveal(
  comparisonPath: string | undefined,
  side: 'additions' | undefined,
  selectLine: (path: string, range: SelectedLineRange) => void
): (node: HTMLElement, instance: unknown, phase: string) => void {
  const renderedRef = useRef<{ node: HTMLElement; instance: LinePositioned } | null>(null)
  const revealRef = useRef<() => void>(() => {})
  const revision = useRevealRevision()

  useLayoutEffect(() => {
    revealRef.current = () => {
      const location = pendingReveal(comparisonPath)
      const rendered = renderedRef.current
      if (location == null || rendered == null || comparisonPath == null) return
      const scroller = rendered.node.closest<HTMLElement>('.diff-scroll')
      const position = rendered.instance.getLinePosition?.(location.line, side)
      if (scroller == null || position == null) return
      takeReveal(location)
      const fileTop = rendered.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      scroller.scrollTo({
        top: Math.max(0, fileTop + position.top - scroller.clientHeight * REVEAL_FROM_TOP),
        behavior: 'instant'
      })
      selectLine(comparisonPath, { start: location.line, end: location.line, ...(side == null ? {} : { side }) })
    }
    revealRef.current()
  }, [comparisonPath, revision, selectLine, side])

  return useCallback((node: HTMLElement, instance: unknown, phase: string) => {
    if (phase === 'unmount') {
      if (renderedRef.current?.node === node) renderedRef.current = null
      return
    }
    renderedRef.current = { node, instance: instance as LinePositioned }
    revealRef.current()
  }, [])
}
