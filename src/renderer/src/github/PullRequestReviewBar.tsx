import { useEffect, useRef } from 'react'
import './PullRequestReviewBar.css'

import type { PullRequestReviewEvent } from '../../../shared/contracts'
import { PullRequestReviewComposer } from './PullRequestReviewComposer'
import { PullRequestReviewSummaryBar, type NewRevisionNotice } from './PullRequestReviewSummaryBar'
import { useOptionalState } from '../app/useOptionalState'

interface PullRequestReviewBarProps {
  submitting: boolean
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  viewerCanSubmitDecision: boolean
  newRevision?: NewRevisionNotice | null
  variant?: 'toolbar' | 'finish'
  expanded?: boolean
  body?: string
  onExpandedChange?(expanded: boolean): void
  onBodyChange?(body: string): void
  onOpen(): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

export function PullRequestReviewBar({
  submitting,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  viewerCanSubmitDecision,
  newRevision = null,
  variant = 'toolbar',
  expanded: expandedProp,
  body: bodyProp,
  onExpandedChange,
  onBodyChange,
  onOpen,
  onSubmit
}: PullRequestReviewBarProps): React.JSX.Element {
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

  if (!finish && !expanded) {
    return (
      <PullRequestReviewSummaryBar
        message={message}
        inlineCommentCount={inlineCommentCount}
        orphanedCommentCount={orphanedCommentCount}
        newRevision={newRevision}
        onSubmitReview={() => { onOpen(); setExpanded(true) }}
      />
    )
  }

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
