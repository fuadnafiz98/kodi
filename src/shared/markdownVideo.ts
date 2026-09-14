const VIDEO_EXTENSION = /\.(webm|mp4|mov|m4v)(?:$|[?#])/i

export function isVideoMarkdownHref(href: string | undefined): boolean {
  return href != null && VIDEO_EXTENSION.test(href)
}

export function videoMimeTypeFromHref(href: string): string {
  if (/\.webm(?:$|[?#])/i.test(href)) return 'video/webm'
  if (/\.mov(?:$|[?#])/i.test(href)) return 'video/quicktime'
  if (/\.m4v(?:$|[?#])/i.test(href)) return 'video/x-m4v'
  return 'video/mp4'
}

export function isAllowedGitHubMediaUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'github.com'
    || host.endsWith('.github.com')
    || host.endsWith('.githubusercontent.com')
}

export function markdownLinkText(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return ''
  return children.map((child) => markdownLinkText(child)).join('')
}

export function isVideoMarkdownLink(href: string | undefined, children: unknown): boolean {
  if (isVideoMarkdownHref(href)) return true
  return VIDEO_EXTENSION.test(markdownLinkText(children))
}
