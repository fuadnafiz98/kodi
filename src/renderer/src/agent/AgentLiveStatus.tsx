export function LiveStatus({ label }: { label: string }): React.JSX.Element {
  return <div className="agent-live-status" role="status" aria-live="polite">
    <i className="agent-live-dot" aria-hidden="true" /><span>{label}</span>
  </div>
}
