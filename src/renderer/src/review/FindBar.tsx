import { useEffect, useEffectEvent, useState } from 'react'

import { createLazyModule, useLazyModule } from '../app/lazyModule'
import { deepActiveElement } from '../settings/keybindings'

// Most sessions never press ⌘F: the panel loads on the first one and takes over
// the keys from then on.
const findPanelModule = createLazyModule(() => import('./FindPanel'))

export function FindBar(): React.JSX.Element | null {
  const [wanted, setWanted] = useState(false)
  const panel = useLazyModule(findPanelModule, wanted)

  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (wanted || event.defaultPrevented) return
    const commandKey = event.metaKey || event.ctrlKey
    if (!commandKey || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return
    // The editor has a find of its own while the caret is in it.
    const active = deepActiveElement(document)
    if (active instanceof HTMLElement && active.isContentEditable) return
    event.preventDefault()
    setWanted(true)
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // The module outlives this host (a workspace remount), so the panel is drawn
  // only once this host has been asked for it.
  return wanted && panel != null ? <panel.FindPanel /> : null
}
