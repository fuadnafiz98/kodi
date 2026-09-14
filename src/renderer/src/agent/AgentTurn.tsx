import { memo } from 'react'

import { AgentActivityTimeline } from './AgentActivityTimeline'
import { AnswerActions } from './AgentAnswerActions'
import { TurnMeta } from './AgentTurnMeta'
import { UsageSummary } from './AgentUsageSummary'
import { MarkdownContent } from '../markdown/MarkdownContent'
import type { AgentTurnRecord } from './useAgentAnswer'

// Archived turns never change again, and their props keep identity, so an
// answer streaming below them must not re-render the whole history per token.
export const AgentTurn = memo(function AgentTurn({ turn }: { turn: AgentTurnRecord }): React.JSX.Element {
  return (
    <article className="agent-turn archived">
      <p className="agent-question">{turn.question}</p>
      <TurnMeta provider={turn.provider} model={turn.model} effort={turn.effort}
        accessMode={turn.accessMode} running={false} startedAt={turn.startedAt}
        completedAt={turn.completedAt} />
      {turn.activity.length > 0 ? (
        <AgentActivityTimeline items={turn.activity} streaming={false} liveLabel="Complete" />
      ) : null}
      {turn.error == null ? null : <div className="agent-dock-error" role="alert">{turn.error}</div>}
      {turn.blocks.length === 0 ? null : <MarkdownContent blocks={turn.blocks} className="agent-answer" />}
      {turn.usage == null ? null : <UsageSummary usage={turn.usage} />}
      {turn.answer === '' ? null : <AnswerActions answer={turn.answer} />}
    </article>
  )
})
