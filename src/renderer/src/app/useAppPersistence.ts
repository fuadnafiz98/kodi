import { useEffect } from 'react'

import type { FileComparison } from '../../../shared/contracts'
import { cachedFileTextFromComparison, cachedFileTextIdentity } from '../../../shared/workspaceCache'
import type { WorkspaceView } from './AppView'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, savePreferences, type AppPreferences } from '../settings/preferences'
import { themeCanvas } from '../settings/themePalette'
import { useDebouncedPersist } from './useDebouncedPersist'

export interface AppPersistenceOptions {
  preferences: AppPreferences
  /** `null` while no folder is open, which parks every workspace-scoped write. */
  root: string | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  comparison: FileComparison | null
}

/**
 * The writes that follow the reader around: fonts and theme onto the document,
 * preferences to disk, and the workspace's UI state plus the open file's text
 * into the cache main paints from on the next launch.
 */
export function useAppPersistence({
  preferences,
  root,
  selectedPath,
  workspaceView,
  comparison
}: AppPersistenceOptions): void {
  useEffect(() => {
    const documentRoot = document.documentElement
    documentRoot.style.setProperty('--font-ui', INTERFACE_FONTS[preferences.interfaceFont].fontFamily)
    documentRoot.style.setProperty('--font-mono', CODE_FONTS[preferences.codeFont].fontFamily)
    documentRoot.style.setProperty('--ui-text-scale', `${preferences.interfaceFontScale / 100}`)
    // The document background reads --canvas on :root, so the themed canvas has
    // to live there; the shell subtree gets the same value through its own vars.
    const canvas = themeCanvas(preferences.editorTheme)
    documentRoot.style.setProperty('--canvas', canvas)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas)
  }, [preferences.codeFont, preferences.editorTheme, preferences.interfaceFont, preferences.interfaceFontScale])

  useDebouncedPersist(preferences, (settledPreferences) => {
    savePreferences(settledPreferences)
    // Main paints the window background before the renderer exists, so it needs
    // its own copy of the preferences that decide what the first frame looks like.
    void window.repository?.setStartupPreferences({
      themeType: getEditorThemeType(settledPreferences.editorTheme),
      restoreLastFolder: settledPreferences.restoreLastFolder,
      windowBackground: themeCanvas(settledPreferences.editorTheme)
    })
  }, 150)

  useDebouncedPersist(
    root == null ? null : `${root}\0${selectedPath ?? ''}\0${workspaceView}`,
    () => {
      if (root == null) return
      void window.repository?.persistWorkspaceUi({ selectedPath, workspaceView })
    },
    250
  )

  // The open file's text is its own message, keyed on the content hash main
  // already computed: reselecting a file or flipping the view no longer ships
  // half a megabyte across IPC, and an unchanged file ships nothing at all.
  useDebouncedPersist(
    root == null ? null : cachedFileTextIdentity(comparison),
    () => {
      if (root == null) return
      void window.repository?.persistFileText(cachedFileTextFromComparison(comparison))
    },
    250
  )
}
