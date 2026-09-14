import { useState, type Dispatch, type SetStateAction } from 'react'

import { EMPTY_REVIEW_FILE_FILTER, type ReviewFileFilter } from './reviewFileFilter'

export interface ReviewDraft {
  fileFilter: ReviewFileFilter
  setFileFilter: Dispatch<SetStateAction<ReviewFileFilter>>
  composerExpanded: boolean
  setComposerExpanded: Dispatch<SetStateAction<boolean>>
  composerBody: string
  setComposerBody: Dispatch<SetStateAction<string>>
}

/**
 * The explorer filter and the review composer belong to one review. Switching
 * reviews clears them while the render that brings the new identity in is still
 * happening, so the next review never paints with the previous one's filter or
 * half-written summary — which an effect-based reset always did for one frame.
 *
 * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 */
export function useReviewDraft(reviewIdentity: string): ReviewDraft {
  const [fileFilter, setFileFilter] = useState<ReviewFileFilter>(EMPTY_REVIEW_FILE_FILTER)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [composerBody, setComposerBody] = useState('')
  const [identity, setIdentity] = useState(reviewIdentity)

  if (identity !== reviewIdentity) {
    setIdentity(reviewIdentity)
    setFileFilter(EMPTY_REVIEW_FILE_FILTER)
    setComposerExpanded(false)
    setComposerBody('')
    // React discards this pass and re-runs with the values above; handing them
    // back now keeps the discarded pass from filtering the tree with a stale query.
    return {
      fileFilter: EMPTY_REVIEW_FILE_FILTER,
      setFileFilter,
      composerExpanded: false,
      setComposerExpanded,
      composerBody: '',
      setComposerBody
    }
  }

  return {
    fileFilter,
    setFileFilter,
    composerExpanded,
    setComposerExpanded,
    composerBody,
    setComposerBody
  }
}
