import { IconChevronSm } from '@pierre/icons'

// Clearing a select's native appearance is the only way to give it the app's
// squircle corners, and that also removes the platform arrow. Every select
// wraps in this so the replacement chevron stays identical across the app.
export function SelectControl({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="select-control">
      {children}
      <IconChevronSm aria-hidden="true" />
    </span>
  )
}
