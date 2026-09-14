import { useEffect, useState } from 'react'
import { useVirtualizer } from '@pierre/diffs/react'

import { BackToTopButton, BACK_TO_TOP_THRESHOLD, preferredScrollBehavior } from './BackToTopButton'

export function VirtualizedBackToTop(): React.JSX.Element {
  const virtualizer = useVirtualizer()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const currentVirtualizer = virtualizer
    if (currentVirtualizer == null) return
    const root = currentVirtualizer.getRoot()
    if (!(root instanceof HTMLElement)) return
    // Scroll fires per frame while a long review is flung; reading scrollTop
    // there costs a layout flush, so the read is coalesced into one rAF.
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      setVisible(currentVirtualizer.getScrollTop() > BACK_TO_TOP_THRESHOLD)
    }
    const handleScroll = (): void => {
      if (frame == null) frame = requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', handleScroll, { passive: true })
    measure()
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      root.removeEventListener('scroll', handleScroll)
    }
  }, [virtualizer])

  return (
    <BackToTopButton
      visible={visible}
      onClick={() => virtualizer?.scrollTo({ top: 0, behavior: preferredScrollBehavior() })}
    />
  )
}
