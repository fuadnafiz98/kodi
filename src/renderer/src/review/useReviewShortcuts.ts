import { useEffect, useRef } from 'react'

import { deepActiveElement, reviewCommandFromEvent, type ReviewCommand } from '../settings/keybindings'

export interface ReviewItemCommand {
  command: ReviewCommand
  path: string
  revision: number
}

interface ReviewShortcutsOptions {
  active: boolean
  paths: readonly string[]
  currentPathRef: React.RefObject<string | null>
  onNavigate(path: string): void
  onItemCommand(command: ReviewCommand, path: string): void
}

// The listener stays subscribed for the whole review: its inputs move through a
// ref so a changed path list or callback cannot re-bind the window handler.
export function useReviewShortcuts({
  active,
  paths,
  currentPathRef,
  onNavigate,
  onItemCommand
}: ReviewShortcutsOptions): void {
  const optionsRef = useRef({ paths, currentPathRef, onNavigate, onItemCommand })
  useEffect(() => {
    optionsRef.current = { paths, currentPathRef, onNavigate, onItemCommand }
  }, [currentPathRef, onItemCommand, onNavigate, paths])

  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      const command = reviewCommandFromEvent(event, deepActiveElement(document))
      if (command == null) return
      const options = optionsRef.current
      const currentPath = options.currentPathRef.current ?? options.paths[0] ?? null
      if (currentPath == null) return
      event.preventDefault()
      if (command !== 'nextReviewFile' && command !== 'previousReviewFile') {
        options.onItemCommand(command, currentPath)
        return
      }
      const index = options.paths.indexOf(currentPath)
      const step = command === 'nextReviewFile' ? 1 : -1
      const boundedIndex = Math.min(Math.max(index + step, 0), options.paths.length - 1)
      const nextPath = options.paths[boundedIndex]
      if (nextPath == null || nextPath === currentPath) return
      options.onNavigate(nextPath)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active])
}
