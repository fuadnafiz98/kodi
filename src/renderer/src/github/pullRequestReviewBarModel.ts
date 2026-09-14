/**
 * The one line the collapsed review bar shows: a submission result if there is
 * one, otherwise whatever most needs the reader's attention.
 */
export function reviewBarSummary(
  message: string | null,
  inlineCommentCount: number,
  orphanedCommentCount: number
): string {
  if (message != null) return message
  if (orphanedCommentCount > 0) {
    const needs = orphanedCommentCount === 1 ? 'comment needs' : 'comments need'
    return `${orphanedCommentCount} orphaned ${needs} attention`
  }
  if (inlineCommentCount === 0) return 'Review this pull request on GitHub'
  const comments = inlineCommentCount === 1 ? 'comment' : 'comments'
  return `${inlineCommentCount} inline ${comments} ready`
}
