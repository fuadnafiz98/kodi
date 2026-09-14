export type GitHubMarkdownVariant = 'document' | 'comment'

export interface GitHubMarkdownProps {
  source: string
  className?: string
  variant?: GitHubMarkdownVariant
  hrefMode?: 'github' | 'local'
}

export function resolveGitHubHref(href: string | undefined): string | undefined {
  if (href?.startsWith('/') === true) return `https://github.com${href}`
  return href
}

const EXTERNAL_HREF = /^(https?:|mailto:)/i

export function isExternalMarkdownHref(href: string | undefined): boolean {
  return href != null && EXTERNAL_HREF.test(href)
}

/**
 * The rendered markdown and the raw fallback share a wrapper so swapping one for
 * the other when the renderer chunk lands does not move the text.
 */
export function githubMarkdownClassName(
  className: string | undefined,
  variant: GitHubMarkdownVariant
): string {
  return [
    className,
    'gh-markdown',
    variant === 'comment' ? 'comment' : null
  ].filter((value): value is string => value != null && value !== '').join(' ')
}
