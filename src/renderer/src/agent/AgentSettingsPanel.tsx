import { IconShieldKeyhole } from '@pierre/icons'

import type { AgentAccessMode, AgentModelOption, AgentProvider } from '../../../shared/contracts'
import { AgentConfigField } from './AgentConfigField'
import { ACCESS_MODES, EFFORT_LABELS } from './agentPanelOptions'
import { AgentSelect } from './AgentSelect'
import type { ConfirmRequest } from '../app/ConfirmDialog'

export interface AgentSettingsPanelProps {
  provider: AgentProvider
  model: string
  effort: string
  accessMode: AgentAccessMode
  /** Patch and Since worlds have no writable checkout, so access is pinned. */
  accessModeLocked: boolean
  models: readonly AgentModelOption[]
  efforts: readonly string[]
  loadingModels: boolean
  selectedModel: AgentModelOption | undefined
  onProviderChange(provider: AgentProvider): void
  onModelChange(model: string): void
  onEffortChange(effort: string): void
  onAccessModeChange(accessMode: AgentAccessMode): void
  onConfirm(request: ConfirmRequest): Promise<boolean>
}

export function AgentSettingsPanel({
  provider,
  model,
  effort,
  accessMode,
  accessModeLocked,
  models,
  efforts,
  loadingModels,
  selectedModel,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onAccessModeChange,
  onConfirm
}: AgentSettingsPanelProps): React.JSX.Element {
  return (
    <div className="agent-config-panel agent-state-surface" aria-label="Agent settings">
      <AgentConfigField label="Provider" controlId="agent-provider">
        <AgentSelect label="Provider" name="agent-provider" value={provider}
          onChange={(value) => onProviderChange(value as AgentProvider)}>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </AgentSelect>
      </AgentConfigField>
      <AgentConfigField label="Model" controlId="agent-model">
        <AgentSelect label="Model" name="agent-model" value={model} disabled={loadingModels}
          title={selectedModel?.description} onChange={onModelChange} grow>
          {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </AgentSelect>
      </AgentConfigField>
      <AgentConfigField label="Access" controlId="agent-access">
        <AgentSelect label="Access" name="agent-access" value={accessMode}
          disabled={accessModeLocked}
          title={accessModeLocked
            ? 'Patch and Since tabs are read-only because they do not own a writable checkout.'
            : ACCESS_MODES[accessMode].description}
          onChange={async (value) => {
            const nextMode = value as AgentAccessMode
            if (nextMode === 'full-access' && accessMode !== 'full-access' &&
                !(await onConfirm({
                  title: 'Enable full access?',
                  detail: 'The agent can run commands and change files without approval until Kodi restarts.',
                  confirmLabel: 'Enable full access',
                  destructive: true
                }))) return
            onAccessModeChange(nextMode)
          }}>
          {Object.entries(ACCESS_MODES).map(([value, option]) =>
            <option key={value} value={value}>{option.label}</option>)}
        </AgentSelect>
      </AgentConfigField>
      <AgentConfigField label="Effort" controlId="agent-effort">
        <AgentSelect label="Reasoning effort" name="agent-effort" value={effort}
          disabled={efforts.length === 0} onChange={onEffortChange}>
          {efforts.length === 0 ? <option value="">Standard</option> : efforts.map((value) =>
            <option key={value} value={value}>{EFFORT_LABELS[value] ?? value}</option>)}
        </AgentSelect>
      </AgentConfigField>
      <p className="agent-config-help"><IconShieldKeyhole aria-hidden="true" />
        {accessModeLocked
          ? 'Patch and Since tabs are locked to Review access. The agent receives exact selected code but cannot modify another checkout.'
          : ACCESS_MODES[accessMode].description}</p>
    </div>
  )
}
