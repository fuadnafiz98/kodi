import type { ReviewGuideReply } from '../../../shared/reviewGuide'
import { reviewGuideStore } from './reviewGuideStore'

/** Shows the guide a `kodi --guide-file` named on its review, in the Guide view. */
export function showExternalGuide(tabId: string, reply: ReviewGuideReply): void {
  const host = window.__kodiReviewGuide
  if (host != null) reviewGuideStore.connect(host)
  reviewGuideStore.adopt(tabId, reply)
  host?.setView(tabId, 'guide')
}
