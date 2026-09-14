import { IconChevronSm } from '@pierre/icons'

export function AgentSelect({ label, name, value, title, disabled, grow, children, onChange }: {
  label: string
  name: string
  value: string
  title?: string
  disabled?: boolean
  grow?: boolean
  children: React.ReactNode
  onChange(value: string): void
}): React.JSX.Element {
  return <span className={`agent-select select-control ${grow ? 'grow' : ''}`} title={title}>
    <select id={name} name={name} aria-label={label} value={value} disabled={disabled}
      onChange={(event) => onChange(event.target.value)}>{children}</select>
    <IconChevronSm aria-hidden="true" />
  </span>
}
