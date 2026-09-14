import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import './GitHubMarkdownRenderer.css'

import { isVideoMarkdownHref, isVideoMarkdownLink, markdownLinkText } from '../../../shared/markdownVideo'
import {
  githubMarkdownClassName,
  isExternalMarkdownHref,
  resolveGitHubHref,
  type GitHubMarkdownProps
} from './githubMarkdown'
import { MarkdownVideo } from '../markdown/MarkdownVideo'

const GITHUB_MARKDOWN_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'video', 'source'],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    video: [
      ...(defaultSchema.attributes?.video ?? []),
      'src',
      'controls',
      'muted',
      'loop',
      'playsinline',
      'poster',
      'width',
      'height',
      'preload'
    ],
    source: [...(defaultSchema.attributes?.source ?? []), 'src', 'type']
  }
}

function MarkdownLink({
  href,
  children,
  hrefMode,
  ...props
}: React.ComponentProps<'a'> & { hrefMode: 'github' | 'local' }): React.JSX.Element {
  const resolvedHref = hrefMode === 'github' ? resolveGitHubHref(href) : href
  if (resolvedHref != null && isVideoMarkdownLink(resolvedHref, children)) {
    return <MarkdownVideo href={resolvedHref} label={markdownLinkText(children) || resolvedHref} />
  }
  const external = isExternalMarkdownHref(resolvedHref)
  return (
    <a {...props} href={resolvedHref}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={external || resolvedHref?.startsWith('#') === true
        ? undefined
        : (event) => { event.preventDefault() }}>
      {children}
    </a>
  )
}

/**
 * The remark/rehype pipeline and its parse5 HTML parser are ~240 KB. They live
 * behind this module's own chunk so the workspace and viewer bundles no longer
 * carry them; `GitHubMarkdownContent` is the loader.
 */
export default function GitHubMarkdownRenderer({
  source,
  className,
  variant = 'document',
  hrefMode = 'github'
}: GitHubMarkdownProps): React.JSX.Element {
  return (
    <div className={githubMarkdownClassName(className, variant)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, GITHUB_MARKDOWN_SCHEMA]]}
        components={{
          a: (props) => <MarkdownLink {...props} hrefMode={hrefMode} />,
          video: ({ src, children }) => {
            if (src != null && isVideoMarkdownHref(src)) {
              return <MarkdownVideo href={src} label={src} />
            }
            return <>{children}</>
          }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
