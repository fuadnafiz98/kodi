import { IconWarningOctogonFill } from '@pierre/icons'

import type { AgentApprovalDecision, AgentApprovalRequest } from '../../../shared/contracts'

export interface AgentApprovalRequestsProps {
  approvals: readonly AgentApprovalRequest[]
  onApprovalDecision(requestId: string, decision: AgentApprovalDecision): void
}

/** Everything the agent is waiting on the reader to allow or deny. */
export function AgentApprovalRequests({
  approvals,
  onApprovalDecision
}: AgentApprovalRequestsProps): React.JSX.Element {
  return (
    <>
      {approvals.map((approval) => (
        <section className="agent-approval agent-state-surface" key={approval.requestId}
          aria-label="Agent approval request">
          <div className="agent-approval-heading">
            <IconWarningOctogonFill aria-hidden="true" />
            <span><strong>{approval.title}</strong><small>{approval.detail}</small></span>
          </div>
          <div className="agent-approval-actions">
            <button type="button" onClick={() => onApprovalDecision(approval.requestId, 'decline')}>Deny</button>
            <button type="button" onClick={() => onApprovalDecision(approval.requestId, 'acceptForSession')}>Allow for session</button>
            <button type="button" className="primary" onClick={() => onApprovalDecision(approval.requestId, 'accept')}>Allow once</button>
          </div>
        </section>
      ))}
    </>
  )
}
