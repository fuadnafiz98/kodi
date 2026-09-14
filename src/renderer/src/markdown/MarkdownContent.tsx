import { memo, useMemo } from 'react'

import { keyForBlock, keyForInline, type MarkdownBlock, type MarkdownInline } from './markdown'

function InlineRun({ inline }: { inline: MarkdownInline }): React.JSX.Element {
  if (inline.kind === 'code') return <code>{inline.text}</code>
  if (inline.kind === 'strong') return <strong>{inline.text}</strong>
  if (inline.kind === 'emphasis') return <em>{inline.text}</em>
  return <>{inline.text}</>
}

function InlineContent({ content }: { content: MarkdownInline[] }): React.JSX.Element {
  const seen = new Map<string, number>()
  return <>{content.map((inline) => <InlineRun key={keyForInline(inline, seen)} inline={inline} />)}</>
}

// A streamed answer re-derives its block array on every chunk, but
// `advanceStreamingMarkdown` keeps the settled blocks' object identity — so
// rendering each block through a memo means only the growing tail re-renders.
const Block = memo(function Block({ block }: { block: MarkdownBlock }): React.JSX.Element {
  if (block.kind === 'code') {
    return (
      <pre>
        {block.language == null ? null : <span className="agent-code-language">{block.language}</span>}
        <code>{block.text}</code>
      </pre>
    )
  }
  if (block.kind === 'heading') {
    const Heading = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
    return <Heading><InlineContent content={block.content} /></Heading>
  }
  if (block.kind === 'quote') {
    return <blockquote><InlineContent content={block.content} /></blockquote>
  }
  if (block.kind === 'list') {
    const itemKeys = new Map<string, number>()
    return block.ordered
      ? <ol>{block.items.map((item) => <li key={keyForInline(item[0] ?? { kind: 'text', text: '' }, itemKeys)}><InlineContent content={item} /></li>)}</ol>
      : <ul>{block.items.map((item) => <li key={keyForInline(item[0] ?? { kind: 'text', text: '' }, itemKeys)}><InlineContent content={item} /></li>)}</ul>
  }
  return <p><InlineContent content={block.content} /></p>
})

/**
 * Shared by the agent answer and GitHub review comments: both arrive as markdown
 * from somewhere else, and both are read in narrow columns beside code.
 */
export const MarkdownContent = memo(function MarkdownContent({
  blocks,
  className
}: {
  blocks: MarkdownBlock[]
  className: string
}): React.JSX.Element {
  const keyed = useMemo(() => {
    const seen = new Map<string, number>()
    return blocks.map((block) => ({ block, key: keyForBlock(block, seen) }))
  }, [blocks])
  return (
    <div className={className}>
      {keyed.map(({ block, key }) => <Block key={key} block={block} />)}
    </div>
  )
})
