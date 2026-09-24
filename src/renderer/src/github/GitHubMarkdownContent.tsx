import { memo, useEffect, useState } from 'react'

import { githubMarkdownClassName, type GitHubMarkdownProps } from './githubMarkdown'

type GitHubMarkdownRendererComponent = typeof import('./GitHubMarkdownRenderer').default

// A module store rather than `React.lazy`: a lazy component only starts loading
// once it renders, and its first render always suspends. Surfaces that reserve
// their space (the pull request context) need to ask "is it here yet?" and hold
// a placeholder until it is, instead of painting the raw source and reflowing.
let loadedRenderer: GitHubMarkdownRendererComponent | null = null
let rendererLoad: Promise<GitHubMarkdownRendererComponent> | null = null

/** Starts the remark/rehype chunk; safe to call any number of times. */
export function loadGitHubMarkdownRenderer(): Promise<GitHubMarkdownRendererComponent> {
  rendererLoad ??= import('./GitHubMarkdownRenderer').then((module) => {
    loadedRenderer = module.default
    return module.default
  }, (error: unknown) => {
    rendererLoad = null
    throw error
  })
  return rendererLoad
}

/** The renderer once its chunk has arrived; asking for it starts the load. */
export function useGitHubMarkdownRenderer(): GitHubMarkdownRendererComponent | null {
  const [renderer, setRenderer] = useState(() => loadedRenderer)
  useEffect(() => {
    if (renderer != null) return
    let cancelled = false
    void loadGitHubMarkdownRenderer().then((loaded) => {
      if (!cancelled) setRenderer(() => loaded)
    }, () => undefined)
    return () => { cancelled = true }
  }, [renderer])
  return renderer
}

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
  const Renderer = useGitHubMarkdownRenderer()
  return Renderer == null ? <GitHubMarkdownFallback {...props} /> : <Renderer {...props} />
})
