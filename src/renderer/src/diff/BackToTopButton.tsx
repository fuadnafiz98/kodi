import { IconChevron } from '@pierre/icons'

interface BackToTopButtonProps {
  visible: boolean
  onClick(): void
}

export const BACK_TO_TOP_THRESHOLD = 480

export function BackToTopButton({ visible, onClick }: BackToTopButtonProps): React.JSX.Element {
  return (
    <button
      className={`back-to-top ${visible ? 'visible' : ''}`}
      type="button"
      onClick={onClick}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
    >
      <IconChevron aria-hidden="true" />
      <span>Back to top</span>
    </button>
  )
}

export function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
