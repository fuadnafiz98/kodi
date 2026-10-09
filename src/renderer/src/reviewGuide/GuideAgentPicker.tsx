import { IconChevronSm, IconPerson } from '@pierre/icons'

import type { AgentModelOption, AgentProvider } from '../../../shared/contracts'
import { setGuideAgentChoice, useGuideAgentCatalog, useGuideAgentChoice } from './guideAgentSettings'
import type { GuideAgentContext } from './reviewGuideHost'

const PROVIDER_NAMES: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' }
const EFFORT_NAMES: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra'
}

function Select({ id, label, value, disabled, children, onChange }: {
  id: string
  label: string
  value: string
  disabled?: boolean
  children: React.ReactNode
  onChange(value: string): void
}): React.JSX.Element {
  return (
    <div className="guide-field">
      <label htmlFor={id}>{label}</label>
      <span className="guide-select">
        <select id={id} name={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <IconChevronSm aria-hidden="true" />
      </span>
    </div>
  )
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function defaultModel(models: readonly AgentModelOption[]): AgentModelOption | undefined {
  return models.find((option) => option.default === true) ?? models[0]
}

/**
 * Which model writes the guide, how hard it thinks, what to focus on, and who
 * is signed in to it. Follows the agent dock until another provider is picked.
 */
export function GuideAgentPicker({ dock }: { dock: GuideAgentContext | null }): React.JSX.Element {
  const choice = useGuideAgentChoice()
  const { catalog, statuses, refresh } = useGuideAgentCatalog()
  const provider: AgentProvider = choice.provider ?? dock?.provider ?? 'claude'
  const models = catalog?.[provider] ?? (dock?.provider === provider ? dock.models : [])
  const model = choice.provider == null ? dock?.model ?? '' : choice.model
  const effort = choice.provider == null ? dock?.effort ?? '' : choice.effort
  const selected = models.find((option) => option.id === model)
  const efforts = selected?.efforts ?? []
  const status = statuses?.[provider] ?? null
  const dockModel = dock == null ? '' : dock.models.find((option) => option.id === dock.model)?.label ?? dock.model

  // Changing the model or effort while following the dock takes the dock's
  // provider as the Guide's own, so the rest of the dock's choice is kept.
  const own = (change: { model?: string; effort?: string }): void => {
    setGuideAgentChoice({ provider, model, effort, ...change })
  }

  return (
    <div className="guide-agent-picker" data-guide-agent="">
      <Select id="guide-agent-provider" label="Agent" value={choice.provider ?? 'dock'}
        onChange={(value) => {
          if (value === 'dock') {
            setGuideAgentChoice({ provider: null })
            return
          }
          const next = value as AgentProvider
          const fallback = defaultModel(catalog?.[next] ?? [])
          setGuideAgentChoice({ provider: next, model: fallback?.id ?? '', effort: fallback?.defaultEffort ?? '' })
        }}>
        <option value="dock">{dock == null ? 'Agent dock' : `Agent dock · ${PROVIDER_NAMES[dock.provider]}`}</option>
        <option value="claude">{PROVIDER_NAMES.claude}</option>
        <option value="codex">{PROVIDER_NAMES.codex}</option>
      </Select>
      <Select id="guide-agent-model" label="Model" value={model} disabled={models.length === 0}
        onChange={(value) => {
          const option = models.find((candidate) => candidate.id === value)
          own({ model: value, effort: option?.efforts.includes(effort) ? effort : option?.defaultEffort ?? '' })
        }}>
        {models.length === 0 ? <option value={model}>{dockModel === '' ? 'Default' : dockModel}</option> : null}
        {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </Select>
      <Select id="guide-agent-effort" label="Effort" value={effort} disabled={efforts.length === 0}
        onChange={(value) => own({ effort: value })}>
        {efforts.length === 0 ? <option value={effort}>Standard</option> : null}
        {efforts.map((value) => <option key={value} value={value}>{EFFORT_NAMES[value] ?? value}</option>)}
      </Select>
      <div className="guide-field guide-field-wide">
        <label htmlFor="guide-agent-instructions">Focus</label>
        <textarea id="guide-agent-instructions" name="guide-agent-instructions" rows={2}
          value={choice.instructions} placeholder="Optional: what to start with"
          onChange={(event) => setGuideAgentChoice({ instructions: event.target.value })} />
      </div>
      <span className="guide-field-label">Account</span>
      <div className="guide-account" data-guide-account={status == null ? 'unknown' : status.authenticated ? 'signed-in' : 'signed-out'}>
        <IconPerson aria-hidden="true" />
        {status == null ? <span className="guide-account-text">Checking {PROVIDER_NAMES[provider]}…</span>
          : status.authenticated ? (
            <span className="guide-account-text" title={[status.account?.email ?? status.detail, status.account?.organization].filter(Boolean).join(' · ')}>
              {status.account?.email ?? status.detail}
              {status.account?.plan == null ? null : <span className="guide-account-plan">{titleCase(status.account.plan)}</span>}
            </span>
          ) : (
            <>
              <span className="guide-account-text">{status.installed ? 'Not signed in' : 'Not installed'}</span>
              {status.installed && dock != null ? (
                <button type="button" className="guide-link" onClick={() => dock.login(provider)}>Sign in</button>
              ) : null}
              <button type="button" className="guide-link" onClick={refresh}>Check again</button>
            </>
          )}
      </div>
    </div>
  )
}
