import { memo } from 'react'

import { GitHubMarkdownContent } from '../github/GitHubMarkdownContent'

export const MarkdownFilePreview = memo(function MarkdownFilePreview({
  source
}: {
  source: string
}): React.JSX.Element {
  return (
    <div className="diff-scroll markdown-file-scroll">
      <GitHubMarkdownContent
        source={source}
        className="markdown-file-preview"
        hrefMode="local"
      />
    </div>
  )
})
