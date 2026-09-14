import { IconRefresh } from '@pierre/icons'

/** A button's icon, swapped for a spinner while its action is in flight. */
export function ActionIcon({ busy, children }: { busy: boolean; children?: React.ReactNode }): React.JSX.Element | null {
  const icon = busy ? <IconRefresh className="spin" /> : children
  return icon == null ? null : <span className="action-icon-slot">{icon}</span>
}
