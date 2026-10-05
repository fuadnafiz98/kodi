import { useEffect, useState } from 'react'

import { stripMarkdownFrontmatter } from '../review/documentView'
import type { DraftTextChannel } from './draftTextChannel'
import { MarkdownFilePreview } from './MarkdownFilePreview'

// Rendering markdown on every keystroke is the expensive half of a split; a
// pause in the typing is when the reader looks across at it anyway.
const LIVE_PREVIEW_DELAY_MS = 250

/**
 * The split's preview while its source is being edited. The draft only reaches
 * the surface at session boundaries, so this listens for the text itself and is
 * the only component that re-renders as it changes.
 */
export function LiveMarkdownPreview({ source, channel }: {
  source: string
  channel: DraftTextChannel
}): React.JSX.Element {
  // What was typed last, and what the preview has rendered: keystrokes move the
  // first and re-render only this component; the markdown follows a pause later.
  const [typed, setTyped] = useState<{ base: string; text: string } | null>(null)
  const [shown, setShown] = useState<{ base: string; text: string } | null>(null)
  useEffect(() => channel.subscribe((text) => setTyped({ base: source, text })), [channel, source])
  useEffect(() => {
    if (typed == null) return
    const timer = setTimeout(() => setShown({ base: typed.base, text: stripMarkdownFrontmatter(typed.text) }), LIVE_PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [typed])
  return <MarkdownFilePreview source={shown?.base === source ? shown.text : source} />
}
