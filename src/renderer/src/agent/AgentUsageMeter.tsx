/** A 0-100 bar with its own readout, used for context and plan windows. */
export function UsageMeter({ label, value, suffix = '' }: { label: string; value: number; suffix?: string }): React.JSX.Element {
  const safeValue = Math.min(100, Math.max(0, value))
  return <div className="agent-context-meter">
    <div><span>{label}</span><strong>{safeValue.toFixed(value < 10 ? 1 : 0)}%{suffix}</strong></div>
    <meter min="0" max="100" value={safeValue}>{safeValue}%</meter>
  </div>
}
