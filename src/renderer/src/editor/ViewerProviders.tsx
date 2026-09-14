import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { DiffLineAnnotation, FileContents, LineAnnotation } from '@pierre/diffs'
import { EditProvider, WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react'
import type { Editor, EditorOptions } from '@pierre/diffs/edit'

import { DIFF_HIGHLIGHTER_LIMITS, DIFF_HIGHLIGHTER_OPTIONS, DIFF_WORKER_POOL_OPTIONS } from '../diff/diffWorkerConfig'
import type { AppPreferences } from '../settings/preferences'
import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import { createDiffEditor } from '../diff/useFileEditing'
import { buildEditorKeymap } from './editorKeymap'
import type { SelectionActionContext } from './selectionAction'

export type EditorAnnotations =
  | LineAnnotation<ReviewAnnotationMetadata>[]
  | DiffLineAnnotation<ReviewAnnotationMetadata>[]
  | undefined

export interface EditorHandlers {
  onAttach(editor: Editor<ReviewAnnotationMetadata>): void
  onChange(file: FileContents, lineAnnotations: EditorAnnotations): void
  onBlur(): void
  renderSelectionAction(context: SelectionActionContext): HTMLElement
}

interface ViewerContextValue {
  editorOptions: EditorOptions<ReviewAnnotationMetadata>
  setEditorHandlers(handlers: EditorHandlers | null): void
  setViewerSuspended(suspended: boolean): void
}

const ViewerContext = createContext<ViewerContextValue | null>(null)

// Languages whose comment tokens the editor's built-in table does not cover;
// without these ⌘/ inserts `//` into files that have never used it.
const LANGUAGE_COMMENT_CONFIG = {
  fish: { lineComment: '#' },
  toml: { lineComment: '#' },
  tf: { lineComment: '#' },
  hcl: { lineComment: '#' },
  elixir: { lineComment: '#' },
  erlang: { lineComment: '%' },
  haskell: { lineComment: '--', blockComment: ['{-', '-}'] as const },
  graphql: { lineComment: '#' },
  nix: { lineComment: '#', blockComment: ['/*', '*/'] as const },
  properties: { lineComment: '#' }
}

// The pool owns the highlight theme: `setRenderOptions` re-resolves it, clears
// both AST caches and re-renders every mounted instance itself. Threading the
// theme through per-file options as well would make the React wrapper force a
// second full DOM rebuild for the same switch, so only this effect touches it.
function DiffWorkerSync({
  theme,
  suspended
}: {
  theme: AppPreferences['editorTheme']
  suspended: boolean
}): null {
  const workerPool = useWorkerPool()

  useEffect(() => {
    if (workerPool == null || suspended) return
    let active = true
    const push = (): Promise<void> => workerPool.setRenderOptions({ theme, ...DIFF_HIGHLIGHTER_LIMITS })
    // setRenderOptions awaits worker initialization before it publishes anything,
    // so a transient worker failure leaves every file in the previous palette.
    void push().catch(() => (active ? push() : undefined)).catch((error: unknown) => {
      console.error('Failed to update the diff theme:', error)
    })
    return () => {
      active = false
    }
  }, [suspended, theme, workerPool])

  useEffect(() => {
    if (workerPool == null || !suspended) return
    // Unmounting the viewer only frees its DOM. The workers, their Shiki
    // highlighters and both AST caches are the expensive part, and terminate()
    // is recoverable: the next submitted task re-initializes the pool.
    workerPool.terminate()
  }, [suspended, workerPool])

  return null
}

/**
 * Owns everything the diff viewer must keep across a workspace remount: the
 * worker pool, the single `Editor` (`EditProvider` caches it by the identity of
 * the options object, so that object is created exactly once here), and the
 * two-phase worker-theme handshake. Mounted above the keyed
 * `<RepositoryWorkspace>`, so opening a pull request never tears the pool down
 * or drops a file's cached text document and undo history.
 */
export function ViewerProviders({
  theme,
  children
}: {
  theme: AppPreferences['editorTheme']
  children: React.ReactNode
}): React.JSX.Element {
  const [suspended, setSuspended] = useState(false)
  const handlersRef = useRef<EditorHandlers | null>(null)
  // The worker pool is a module singleton that reads these once, at construction.
  // Seeding it with the current theme is what keeps the first screenful from being
  // tokenized against the default palette and then immediately re-tokenized.
  const [highlighterOptions] = useState(() => ({ theme, ...DIFF_HIGHLIGHTER_OPTIONS }))

  // Created once: EditProvider caches the Editor in a WeakMap keyed on this
  // object, so a new identity would mean a new Editor and the loss of every
  // cached text document and undo stack.
  const [editorOptions] = useState<EditorOptions<ReviewAnnotationMetadata>>(() => ({
    historyMaxEntries: 500,
    persistState: true,
    // Selections and scroll survive the automatic reload the main process
    // performs when the renderer goes unresponsive.
    persistStateStorage: 'indexedDB',
    keymap: buildEditorKeymap(),
    languageCommentConfig: LANGUAGE_COMMENT_CONFIG,
    roundedSelection: true,
    matchBrackets: true,
    autoSurround: 'default',
    enabledSelectionAction: true,
    renderSelectionAction: (context: SelectionActionContext) =>
      handlersRef.current?.renderSelectionAction(context) ?? document.createElement('div'),
    onAttach: (editor) => handlersRef.current?.onAttach(editor),
    onChange: (file, lineAnnotations) => handlersRef.current?.onChange(file, lineAnnotations),
    onBlur: () => handlersRef.current?.onBlur(),
    clipboard: {
      readText: (type) => window.repository?.readClipboardText(type) ?? ''
    }
  }))
  const setEditorHandlers = useCallback((handlers: EditorHandlers | null) => {
    handlersRef.current = handlers
  }, [])

  const value = useMemo<ViewerContextValue>(
    () => ({ editorOptions, setEditorHandlers, setViewerSuspended: setSuspended }),
    [editorOptions, setEditorHandlers]
  )

  return (
    <EditProvider<ReviewAnnotationMetadata> createEditor={createDiffEditor}>
      <WorkerPoolContextProvider poolOptions={DIFF_WORKER_POOL_OPTIONS} highlighterOptions={highlighterOptions}>
        <DiffWorkerSync theme={theme} suspended={suspended} />
        <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>
      </WorkerPoolContextProvider>
    </EditProvider>
  )
}

export function useViewerContext(): ViewerContextValue | null {
  return useContext(ViewerContext)
}
