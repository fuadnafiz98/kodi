import type { CodeView, CodeViewItem } from '@pierre/diffs'

/**
 * What ⌘F reads from a mounted multi-file review: the viewer, every item in
 * order (drawn or not), and a way to open a collapsed file. Each mounted review
 * adds one to `window.__kodiReviewFind`; the find panel, loaded on the first
 * ⌘F, searches the one on screen.
 *
 * Types only, and a window global rather than an exported Set: the review sits
 * on the startup path, and any runtime import between it and the lazy find
 * panel put a chunk — or the review's whole preload list — into startup bytes.
 */
export interface ReviewFindSource {
  viewer(): CodeView<unknown> | null | undefined
  items(): readonly CodeViewItem<unknown>[]
  expand(itemId: string): void
}

declare global {
  interface Window {
    __kodiReviewFind?: Set<ReviewFindSource>
  }
}
