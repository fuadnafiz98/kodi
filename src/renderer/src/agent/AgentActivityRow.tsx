import { memo, useState } from 'react'
import { IconChevronSm } from '@pierre/icons'

import type { AgentActivityUpdate } from '../../../shared/contracts'
import { ActivityIcon } from './AgentActivityIcon'
import { formatActivityStatus, formatDuration } from './agentFormat'

export const AgentActivityRow = memo(function AgentActivityRow({ item }: {
  item: AgentActivityUpdate
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = (item.detail ?? '') !== '' || (item.output ?? '') !== ''
  const duration = item.durationMs == null || item.durationMs < 1_000 ? null : formatDuration(item.durationMs)

  return <li className={`agent-activity-item ${item.status}`}>
    {expandable ? <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><ActivityIcon kind={item.kind} /><span>{item.title}</span>
        <small>{duration ?? formatActivityStatus(item.status)}</small>
        <IconChevronSm className="agent-activity-chevron" aria-hidden="true" /></summary>
      {!open || item.detail == null || item.detail === '' ? null : <pre>{item.detail}</pre>}
      {!open || item.output == null || item.output === '' ? null : <pre className="output">{item.output}</pre>}
    </details> : <div className="agent-activity-summary"><ActivityIcon kind={item.kind} />
      <span>{item.title}</span><small>{duration ?? formatActivityStatus(item.status)}</small></div>}
  </li>
})
