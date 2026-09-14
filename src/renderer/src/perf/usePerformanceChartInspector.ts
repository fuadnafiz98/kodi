import { useState, type KeyboardEvent, type PointerEvent } from 'react'

import {
  findNearestSampleIndex,
  interpolateChartY,
  type MemorySample,
  type PerformanceChartGeometry
} from './performanceHistory'
import { CHART_WIDTH } from './performanceChartModel'

export interface PerformanceChartInspector {
  inspectX: number | null
  keyboardExploring: boolean
  inspectedSample: MemorySample | null
  primaryY: number | null
  secondaryY: number | null
  clear(): void
  onPointerMove(event: PointerEvent<HTMLDivElement>): void
  onPointerLeave(): void
  onFocus(): void
  onBlur(): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
}

/**
 * The crosshair: which sample the pointer or the arrow keys are on, and where
 * the two series sit at that x.
 */
export function usePerformanceChartInspector(
  history: readonly MemorySample[],
  chart: PerformanceChartGeometry | null
): PerformanceChartInspector {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [inspectX, setInspectX] = useState<number | null>(null)
  const [keyboardExploring, setKeyboardExploring] = useState(false)

  const firstSample = history[0]
  const latestSample = history[history.length - 1]

  const clear = (): void => {
    setInspectX(null)
    setActiveIndex(null)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (chart == null || firstSample == null || latestSample == null) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const svgX = ((event.clientX - bounds.left) / bounds.width) * CHART_WIDTH
    const plotX = Math.max(chart.plotLeft, Math.min(chart.plotRight, svgX))
    const ratio = (plotX - chart.plotLeft) / (chart.plotRight - chart.plotLeft)
    const atMs = firstSample.atMs + ratio * (latestSample.atMs - firstSample.atMs)
    setKeyboardExploring(false)
    setInspectX(plotX)
    setActiveIndex(findNearestSampleIndex(history, atMs))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (history.length === 0 || chart == null) return
    let nextIndex = activeIndex ?? history.length - 1
    if (event.key === 'ArrowLeft') nextIndex = Math.max(0, nextIndex - 1)
    else if (event.key === 'ArrowRight') nextIndex = Math.min(history.length - 1, nextIndex + 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = history.length - 1
    else return
    event.preventDefault()
    setKeyboardExploring(true)
    setActiveIndex(nextIndex)
    setInspectX(chart.primary.points[nextIndex]?.x ?? null)
  }

  const onFocus = (): void => {
    const next = activeIndex ?? history.length - 1
    setKeyboardExploring(true)
    setActiveIndex(next)
    setInspectX(chart?.primary.points[next]?.x ?? null)
  }

  const onBlur = (): void => {
    setKeyboardExploring(false)
    clear()
  }

  const onPointerLeave = (): void => {
    if (!keyboardExploring) clear()
  }

  return {
    inspectX,
    keyboardExploring,
    inspectedSample: activeIndex == null ? null : history[activeIndex] ?? null,
    primaryY: inspectX == null || chart == null ? null : interpolateChartY(chart.primary.points, inspectX),
    secondaryY: inspectX == null || chart == null ? null : interpolateChartY(chart.secondary.points, inspectX),
    clear,
    onPointerMove,
    onPointerLeave,
    onFocus,
    onBlur,
    onKeyDown
  }
}
