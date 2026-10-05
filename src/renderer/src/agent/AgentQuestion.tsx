import type { AgentReference } from './useAgentAnswer'

export interface AgentQuestionProps {
  question: string
  references: readonly AgentReference[] | undefined
  onOpenReference?(reference: AgentReference): void
}

function referenceLabel(reference: AgentReference): string {
  const name = reference.path.split('/').at(-1) ?? reference.path
  return reference.startLine === reference.endLine
    ? `${name}:${reference.startLine}`
    : `${name}:${reference.startLine}-${reference.endLine}`
}

/**
 * What was asked, with the selections it was asked about. The chips left the
 * composer on send and went nowhere, so a question about `llms.py:164` read
 * as a question about nothing; they stay on the question, and open the file
 * at those lines.
 */
export function AgentQuestion({ question, references, onOpenReference }: AgentQuestionProps): React.JSX.Element | null {
  if (question === '' && (references == null || references.length === 0)) return null
  return (
    <div className="agent-question-group">
      {references == null || references.length === 0 ? null : (
        <ul className="agent-question-references" aria-label="Asked about">
          {references.map((reference) => {
            const label = referenceLabel(reference)
            return (
              <li key={`${reference.path}:${reference.side}:${reference.startLine}-${reference.endLine}`}>
                <button type="button" className="agent-reference"
                  title={`${reference.path}${reference.side === 'deletions' ? ' · old side' : ''}`}
                  onClick={() => onOpenReference?.(reference)}>
                  <code>{label}</code>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {question === '' ? null : <p className="agent-question">{question}</p>}
    </div>
  )
}
