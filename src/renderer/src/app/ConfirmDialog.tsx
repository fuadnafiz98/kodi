import { useEffectEvent, useLayoutEffect, useRef } from 'react'
import { IconWarningOctogonFill } from '@pierre/icons'

export interface ConfirmRequest {
  title: string
  /** One sentence on what happens if they continue. Optional for obvious cases. */
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Paints the confirm button as destructive rather than primary. */
  destructive?: boolean
  /** A glyph naming the decision, in a tile tinted by `tone`. */
  icon?: React.ReactNode
  tone?: 'success' | 'warning' | 'neutral'
  /** What the decision is about, set apart from the sentence describing it. */
  context?: { title: string; meta?: string }
}

interface ConfirmDialogProps extends ConfirmRequest {
  onResolve(confirmed: boolean): void
}

/**
 * A native `window.confirm` is a system sheet carrying the app's title, ignoring
 * the theme and blocking the renderer thread — the loudest "this is a web app"
 * tell in the product. This is the same modality in the app's own language:
 * top-layer `<dialog>`, focus trapped and returned by the platform, Escape
 * cancels.
 */
export function ConfirmDialog({
  title,
  detail,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  destructive = false,
  icon,
  tone = 'neutral',
  context,
  onResolve
}: ConfirmDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const resolveConfirmation = useEffectEvent(onResolve)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    const cancelFromBackdrop = (event: MouseEvent): void => {
      if (event.target === dialog) resolveConfirmation(false)
    }
    dialog.addEventListener('click', cancelFromBackdrop)
    if (!dialog.open) dialog.showModal()
    // The destructive path never opens focused on its own confirm button.
    if (!destructive) confirmRef.current?.focus()
    return () => {
      dialog.removeEventListener('click', cancelFromBackdrop)
      if (dialog.open) dialog.close()
    }
  }, [destructive])

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog-layer"
      aria-labelledby="confirm-dialog-title"
      aria-describedby={detail == null ? undefined : 'confirm-dialog-detail'}
      onCancel={(event) => {
        event.preventDefault()
        onResolve(false)
      }}
    >
      <section className="confirm-dialog" data-tone={tone}>
        <div className="confirm-dialog-body">
          {destructive ? <IconWarningOctogonFill aria-hidden="true" />
            : icon == null ? null : <span className="confirm-dialog-icon" aria-hidden="true">{icon}</span>}
          <div>
            <strong id="confirm-dialog-title">{title}</strong>
            {detail == null ? null : <p id="confirm-dialog-detail">{detail}</p>}
          </div>
        </div>
        {context == null ? null : (
          <div className="confirm-dialog-context">
            <span>{context.title}</span>
            {context.meta == null ? null : <small>{context.meta}</small>}
          </div>
        )}
        <div className="confirm-dialog-actions">
          <button type="button" onClick={() => onResolve(false)}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={destructive ? 'danger' : 'primary'}
            type="button"
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </dialog>
  )
}
