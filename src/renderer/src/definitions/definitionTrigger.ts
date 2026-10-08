/**
 * Startup side of ⌘-click to a definition: one keydown listener that fetches
 * the navigation chunk the first time ⌘ goes down. Until then nothing listens
 * to the pointer, so reading and scrolling pay nothing for it.
 */

export interface DefinitionOpeners {
  /** Shows a file at a line: the review scrolls to it, or the file opens. */
  openFile(path: string, line: number): void
  openInEditor(path: string, line: number): void
  /** The file in front, for a view whose rows carry no file header. */
  currentPath(): string | null
}

export interface DefinitionNavigation {
  metaChanged(down: boolean): void
  dispose(): void
}

let openers: DefinitionOpeners | null = null
let navigation: DefinitionNavigation | null = null
let loading = false
let metaDown = false

export function setDefinitionOpeners(next: DefinitionOpeners | null): void {
  openers = next
}

/** Installs the trigger; returns its teardown. */
export function installDefinitionTrigger(): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Meta') return
    const down = event.type === 'keydown'
    metaDown = down
    if (navigation != null) {
      navigation.metaChanged(down)
      return
    }
    if (!down || loading) return
    loading = true
    void import('./definitionNavigation').then((module) => {
      navigation = module.createDefinitionNavigation(() => openers)
      if (metaDown) navigation.metaChanged(true)
    }, () => {}).finally(() => { loading = false })
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)
  return () => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('keyup', onKey, true)
  }
}
