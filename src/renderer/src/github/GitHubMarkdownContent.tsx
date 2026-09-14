import { lazy, memo, Suspense } from 'react'

import { githubMarkdownClassName, type GitHubMarkdownProps } from './githubMarkdown'

const GitHubMarkdownRenderer = lazy(() => import('./GitHubMarkdownRenderer'))

/** What a reader sees while the renderer chunk is in flight: the source itself. */
export function GitHubMarkdownFallback({
  source,
  className,
  variant = 'document'
}: GitHubMarkdownProps): React.JSX.Element {
  return (
    <div className={githubMarkdownClassName(className, variant)}>
      <pre className="github-markdown-fallback">{source}</pre>
    </div>
  )
}

/**
 * Pull request bodies, review comments and markdown previews are the only
 * surfaces that need the remark/rehype pipeline, and none of them is on the
 * boot path — so it loads on first use and the raw text holds the space.
 */
export const GitHubMarkdownContent = memo(function GitHubMarkdownContent(
  props: GitHubMarkdownProps
): React.JSX.Element {
  return (
    <Suspense fallback={<GitHubMarkdownFallback {...props} />}>
      <GitHubMarkdownRenderer {...props} />
    </Suspense>
  )
})
