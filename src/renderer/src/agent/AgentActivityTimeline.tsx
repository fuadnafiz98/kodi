import { memo, useState } from 'react'
import { IconCheck, IconChevronSm, IconInProgress, IconWarningOctogonFill } from '@pierre/icons'

import type { AgentActivityUpdate } from '../../../shared/contracts'
import { AgentActivityRow } from './AgentActivityRow'

export const AgentActivityTimeline = memo(function AgentActivityTimeline({ items, streaming, liveLabel }: {
  items: readonly AgentActivityUpdate[]
  streaming: boolean
  liveLabel: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const failed = items.some((item) => item.status === 'failed' || item.status === 'blocked')
  const summary = streaming ? liveLabel : failed ? 'Completed with issues' : 'Activity'
  return <details className="agent-work-log" open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="agent-work-log-heading">
      {streaming ? <IconInProgress className="agent-work-log-status running" aria-hidden="true" />
        : failed ? <IconWarningOctogonFill className="agent-work-log-status failed" aria-hidden="true" />
          : <IconCheck className="agent-work-log-status" aria-hidden="true" />}
      <span>{summary}</span><small>{items.length} {items.length === 1 ? 'step' : 'steps'}</small>
      <IconChevronSm className="agent-work-log-chevron" aria-hidden="true" />
    </summary>
    {/* The steps mount only while the timeline is open: a collapsed history of
        20 turns would otherwise hold ~1,600 rows in the document, and every
        reasoning delta would rewrite a text node nobody can see. */}
    {open ? <ol className="agent-activity" aria-label="Agent steps">
      {items.map((item) => <AgentActivityRow item={item} key={item.id} />)}
    </ol> : null}
  </details>
})
