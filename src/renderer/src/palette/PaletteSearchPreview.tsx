import { memo } from 'react'

import { tokenizeSearchPreview } from './searchPreview'

/** One content-search hit, syntax-tinted, with the query run highlighted. */
export const PaletteSearchPreview = memo(function PaletteSearchPreview({
  path,
  preview,
  query
}: { path: string; preview: string; query: string }): React.JSX.Element {
  const tokens = tokenizeSearchPreview(path, preview, query)
  return <>{tokens.map((token, index) => (
    <span
      className={`search-syntax-${token.kind}${token.match ? ' search-query-match' : ''}`}
      key={`${index}:${token.text}`}
    >
      {token.text}
    </span>
  ))}</>
})
