import { IconShieldKeyhole, IconSparkles } from '@pierre/icons'

import { QUICK_PROMPTS } from './agentPanelOptions'

export interface AgentEmptyStateProps {
  /** What the agent would be asked about: the review, the branch, the file. */
  contextLabel: string
  streaming: boolean
  ready: boolean
  onAsk(prompt: string): void
  onCloseSettings(): void
}

export function AgentEmptyState({
  contextLabel,
  streaming,
  ready,
  onAsk,
  onCloseSettings
}: AgentEmptyStateProps): React.JSX.Element {
  return (
    <div className="agent-dock-empty">
      <IconSparkles className="agent-empty-mark" aria-hidden="true" />
      <div>
        <h3>Review with an agent</h3>
        <p>Ask about {contextLabel}, or select diff lines and press <kbd>⌘I</kbd>.</p>
      </div>
      <div className="agent-quick-prompts">
        {QUICK_PROMPTS.map((quick) => (
          <button key={quick.label} type="button" disabled={streaming || !ready}
            onClick={() => { onCloseSettings(); onAsk(quick.prompt) }}>{quick.label}</button>
        ))}
      </div>
      <p className="agent-privacy"><IconShieldKeyhole aria-hidden="true" />
        The selected provider receives repository context only when you send a request.</p>
    </div>
  )
}
