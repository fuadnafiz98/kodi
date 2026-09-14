import type {
  AgentAccessMode,
  AgentActivityUpdate,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentProvider,
  AgentUsageUpdate
} from '../../../shared/contracts'
import { AgentActivityTimeline } from './AgentActivityTimeline'
import { AnswerActions } from './AgentAnswerActions'
import { AgentApprovalRequests } from './AgentApprovalRequests'
import { LiveStatus } from './AgentLiveStatus'
import { TurnMeta } from './AgentTurnMeta'
import { UsageSummary } from './AgentUsageSummary'
import type { MarkdownBlock } from '../markdown/markdown'
import { MarkdownContent } from '../markdown/MarkdownContent'

export interface AgentCurrentTurnProps {
  question: string
  blocks: MarkdownBlock[]
  answer: string
  error: string | null
  streaming: boolean
  activity: readonly AgentActivityUpdate[]
  approvals: readonly AgentApprovalRequest[]
  usage: AgentUsageUpdate | null
  startedAt: number | null
  completedAt: number | null
  provider: AgentProvider
  /** The model's display label, falling back to its id. */
  modelLabel: string
  effort: string
  accessMode: AgentAccessMode
  /** What the timeline says the agent is doing right now. */
  liveLabel: string
  onApprovalDecision(requestId: string, decision: AgentApprovalDecision): void
}

/** The turn in flight, or the last one, below the archived history. */
export function AgentCurrentTurn({
  question,
  blocks,
  answer,
  error,
  streaming,
  activity,
  approvals,
  usage,
  startedAt,
  completedAt,
  provider,
  modelLabel,
  effort,
  accessMode,
  liveLabel,
  onApprovalDecision
}: AgentCurrentTurnProps): React.JSX.Element | null {
  if (question === '' && blocks.length === 0 && activity.length === 0 && error == null) return null
  return (
    <article className="agent-turn current">
      {question === '' ? null : <p className="agent-question">{question}</p>}
      <TurnMeta provider={provider} model={modelLabel} effort={effort}
        accessMode={accessMode} running={streaming} startedAt={startedAt}
        completedAt={completedAt} />
      {activity.length > 0 ? (
        <AgentActivityTimeline items={activity} streaming={streaming} liveLabel={liveLabel} />
      ) : null}

      <AgentApprovalRequests approvals={approvals} onApprovalDecision={onApprovalDecision} />

      {error != null ? <div className="agent-dock-error agent-state-surface" role="alert">{error}</div> : null}
      {blocks.length > 0 ? <MarkdownContent blocks={blocks} className="agent-answer" /> : null}
      {streaming && activity.length === 0 ? <LiveStatus label={liveLabel} /> : null}
      {usage == null || streaming ? null : <UsageSummary usage={usage} />}
      {answer === '' || streaming ? null : <AnswerActions answer={answer} />}
    </article>
  )
}
