import { useEffect, useRef } from 'react'
import './PullRequestReviewBar.css'

import type { PullRequestReviewEvent } from '../../../shared/contracts'
import { PullRequestReviewComposer } from './PullRequestReviewComposer'
import { useOptionalState } from '../app/useOptionalState'

interface PullRequestReviewBarProps {
  /** The decision being posted to GitHub, or null. */
  submitting: PullRequestReviewEvent | null
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  viewerCanSubmitDecision: boolean
  variant?: 'toolbar' | 'finish'
  expanded?: boolean
  body?: string
  onExpandedChange?(expanded: boolean): void
  onBodyChange?(body: string): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

export function PullRequestReviewBar({
  submitting,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  viewerCanSubmitDecision,
  variant = 'toolbar',
  expanded: expandedProp,
  body: bodyProp,
  onExpandedChange,
  onBodyChange,
  onSubmit
}: PullRequestReviewBarProps): React.JSX.Element | null {
  const finish = variant === 'finish'
  const [expanded, setExpanded] = useOptionalState(expandedProp, finish, onExpandedChange)
  const [body, setBody] = useOptionalState(bodyProp, '', onBodyChange)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (expanded && !finish) bodyRef.current?.focus()
  }, [expanded, finish])

  const submit = async (event: PullRequestReviewEvent): Promise<void> => {
    if (!await onSubmit(event, body)) return
    setBody('')
    if (!finish) setExpanded(false)
  }

  // Closed, the toolbar's summary (`ReviewToolbarActions`) stands in for it. It
  // is not drawn from here: this module loads lazily, and a static import back
  // into a startup chunk makes Vite list that chunk's whole preload set.
  if (!finish && !expanded) return null

  return (
    <PullRequestReviewComposer
      variant={variant}
      submitting={submitting}
      message={message}
      inlineCommentCount={inlineCommentCount}
      orphanedCommentCount={orphanedCommentCount}
      viewerCanSubmitDecision={viewerCanSubmitDecision}
      body={body}
      bodyRef={bodyRef}
      onBodyChange={setBody}
      onCancel={() => setExpanded(false)}
      onSubmit={(event) => void submit(event)}
    />
  )
}
