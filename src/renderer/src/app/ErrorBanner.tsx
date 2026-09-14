import { IconWarningOctogonFill, IconX } from '@pierre/icons'

export function ErrorBanner({ message, onDismiss, closing }: {
  message: string
  onDismiss(): void
  closing?: boolean
}): React.JSX.Element {
  return (
    <div className="error-banner" role="alert" data-state={closing === true ? 'closing' : undefined}>
      <IconWarningOctogonFill />
      <span>{message}</span>
      <button type="button" onClick={onDismiss}><IconX /><span className="sr-only">Dismiss</span></button>
    </div>
  )
}
