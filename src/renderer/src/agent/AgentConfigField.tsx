export function AgentConfigField({ label, controlId, children }: {
  label: string
  controlId: string
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="agent-config-field"><label htmlFor={controlId}>{label}</label>{children}</div>
}
