import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import {
  IconReload,
  IconTerminalBashFill,
  IconTrash,
  IconX
} from '@pierre/icons'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './TerminalDock.css'

import type { TerminalSession } from '../../../shared/contracts'
import type { EditorTheme } from '../settings/preferences'
import { terminalThemeFor } from '../settings/themePalette'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { clampTerminalHeight, resistedTerminalHeight, resizedTerminalHeight } from './terminalPanel'
import { useDebouncedPersist } from '../app/useDebouncedPersist'

type TerminalStatus = 'starting' | 'running' | 'exited' | 'failed'

// A window resize should still re-fit, but not once per animation frame: each
// fit reflows the whole scrollback and sends a SIGWINCH to the shell.
const RESIZE_FIT_DELAY_MS = 80

// xterm parses each write() call whole and only yields to the page between
// calls, so the up-to-512 KB tail main replays when the dock is shown again was
// one uninterrupted parse. At 64 KB a slice parses in a few milliseconds and
// xterm's own 12 ms write budget gets a boundary to stop at.
export const TERMINAL_WRITE_CHUNK = 64 * 1_024

/**
 * Hands output to xterm in slices of at most `chunkSize` UTF-16 units, never
 * between the two halves of a surrogate pair. xterm queues every call in order,
 * so live output that arrives while a large replay is still parsing lands
 * behind it rather than inside it.
 */
export function writeTerminalOutput(
  terminal: Pick<Terminal, 'write'>,
  data: string,
  chunkSize: number = TERMINAL_WRITE_CHUNK
): void {
  if (data.length <= chunkSize) {
    terminal.write(data)
    return
  }
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + chunkSize, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    terminal.write(data.slice(start, end))
    start = end
  }
}

export interface TerminalDockHandle {
  focus(): void
}

interface TerminalDockProps {
  open: boolean
  projectName: string
  projectRoot: string
  height: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  scrollback: number
  theme: EditorTheme
  shortcutLabel: string
  onClose(): void
  onHeightChange(height: number): void
  onHeightCommit(height: number): void
  onResizingChange(resizing: boolean): void
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

function terminalStatusLabel(
  status: TerminalStatus,
  shell: string | undefined,
  exitCode: number | null
): string {
  if (status === 'starting') return 'Starting'
  if (status === 'running') return shell ?? 'Running'
  if (status === 'exited') return `Exited ${exitCode ?? ''}`.trim()
  return 'Unavailable'
}

interface TerminalHeaderProps {
  status: TerminalStatus
  statusLabel: string
  contextLabel: string
  cwd: string
  shortcutLabel: string
  onClear(): void
  onRestart(): void
  onClose(): void
}

interface TerminalResizerProps {
  height: number
  onReset(): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onPointerDown(event: PointerEvent<HTMLDivElement>): void
  onPointerMove(event: PointerEvent<HTMLDivElement>): void
  onPointerUp(event: PointerEvent<HTMLDivElement>): void
}

function TerminalResizer({
  height,
  onReset,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: TerminalResizerProps): React.JSX.Element {
  return (
    <div
      className="terminal-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Resize terminal"
      aria-orientation="horizontal"
      aria-valuemin={clampTerminalHeight(0, window.innerHeight)}
      aria-valuemax={clampTerminalHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)}
      aria-valuenow={height}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}

function TerminalHeader({
  status,
  statusLabel,
  contextLabel,
  cwd,
  shortcutLabel,
  onClear,
  onRestart,
  onClose
}: TerminalHeaderProps): React.JSX.Element {
  return (
    <header className="terminal-header">
      <div className="terminal-title">
        <IconTerminalBashFill />
        <strong>Terminal</strong>
        <span className={`terminal-status ${status}`} aria-hidden="true" />
        <span className="sr-only">{statusLabel}</span>
        <span className="terminal-shell">{statusLabel}</span>
      </div>
      <code className="terminal-context" title={cwd}>{contextLabel}</code>
      <div className="terminal-actions">
        <button type="button" onClick={onClear} aria-label="Clear terminal" title="Clear Terminal">
          <IconTrash />
        </button>
        <button type="button" onClick={onRestart} aria-label="Restart terminal" title="Restart Terminal">
          <IconReload />
        </button>
        <button type="button" onClick={onClose} aria-label="Hide terminal" title={`Hide Terminal (${shortcutLabel})`}>
          <IconX />
        </button>
      </div>
    </header>
  )
}

interface TerminalInstanceOptions {
  containerRef: React.RefObject<HTMLDivElement | null>
  terminalRef: React.RefObject<Terminal | null>
  fitRef: React.RefObject<(() => void) | null>
  sessionIdRef: React.RefObject<string | null>
  statusRef: React.RefObject<TerminalStatus>
  dragRef: React.RefObject<{ pointerId: number; startY: number; startHeight: number } | null>
  settingsRef: React.RefObject<{
    fontFamily: string
    fontSize: number
    lineHeight: number
    scrollback: number
    theme: EditorTheme
  }>
  onTitleChange(title: string): void
  restart(resetBuffer: boolean): Promise<void>
}

// Owns the xterm instance itself: construction, renderer, fitting and every
// subscription, so the dock component is left with the session lifecycle.
function useTerminalInstance({
  containerRef,
  terminalRef,
  fitRef,
  sessionIdRef,
  statusRef,
  dragRef,
  settingsRef,
  onTitleChange,
  restart: restartTerminal
}: TerminalInstanceOptions): void {
  const restart = useEffectEvent(restartTerminal)

  useEffect(() => {
    const container = containerRef.current
    if (container == null) return
    const initialSettings = settingsRef.current
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: false,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      fontFamily: initialSettings.fontFamily,
      fontSize: initialSettings.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: initialSettings.lineHeight,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      scrollback: initialSettings.scrollback,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      theme: terminalThemeFor(initialSettings.theme)
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal

    // xterm's core ships only the DOM renderer, which paints every visible row
    // as styled elements on the same thread as React and the diff worker pool.
    let webgl: WebglAddon | null = null
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // Losing the GPU context is recoverable: disposing the addon puts the
        // DOM renderer back rather than leaving a blank terminal.
        if (webgl === addon) webgl = null
        addon.dispose()
      })
      terminal.loadAddon(addon)
      webgl = addon
    } catch {
      // No usable WebGL2 context; the DOM renderer stays in place.
    }

    let fitFrame = 0
    let fitTimer = 0
    const fit = (): void => {
      window.cancelAnimationFrame(fitFrame)
      fitFrame = window.requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) fitAddon.fit()
      })
    }
    fitRef.current = fit
    fit()
    const resizeObserver = new ResizeObserver(() => {
      // The drag moves the container every frame; it gets one fit on release.
      if (dragRef.current != null) return
      window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(fit, RESIZE_FIT_DELAY_MS)
    })
    resizeObserver.observe(container)
    const inputSubscription = terminal.onData((data) => {
      const sessionId = sessionIdRef.current
      if (sessionId != null) requireRepositoryApi().writeTerminal(sessionId, data)
    })
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current
      if (sessionId != null) requireRepositoryApi().resizeTerminal(sessionId, cols, rows)
    })
    const titleSubscription = terminal.onTitleChange(onTitleChange)
    const keySubscription = terminal.onKey(({ domEvent }) => {
      if (domEvent.key !== 'Enter' || sessionIdRef.current != null) return
      if (statusRef.current === 'exited' || statusRef.current === 'failed') {
        void restart(true)
      }
    })

    return () => {
      resizeObserver.disconnect()
      window.cancelAnimationFrame(fitFrame)
      window.clearTimeout(fitTimer)
      inputSubscription.dispose()
      resizeSubscription.dispose()
      titleSubscription.dispose()
      keySubscription.dispose()
      // Before the terminal: disposing the renderer after its terminal throws.
      webgl?.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [containerRef, dragRef, fitRef, onTitleChange, sessionIdRef, settingsRef, statusRef, terminalRef])
}

export const TerminalDock = forwardRef<TerminalDockHandle, TerminalDockProps>(function TerminalDock({
  open,
  projectName,
  projectRoot,
  height,
  fontFamily,
  fontSize,
  lineHeight,
  scrollback,
  theme,
  shortcutLabel,
  onClose,
  onHeightChange,
  onHeightCommit,
  onResizingChange
}, ref): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const disposedRef = useRef(false)
  const generationRef = useRef(0)
  const startingRef = useRef(false)
  const statusRef = useRef<TerminalStatus>('starting')
  const initialSettingsRef = useRef({ fontFamily, fontSize, lineHeight, scrollback, theme })
  const resizeFrameRef = useRef(0)
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('starting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processTitle, setProcessTitle] = useState('')

  const updateStatus = useCallback((nextStatus: TerminalStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  const startTerminal = useCallback(async (resetBuffer: boolean) => {
    if (startingRef.current) return
    const terminal = terminalRef.current
    if (terminal == null) return
    startingRef.current = true
    const generation = generationRef.current + 1
    generationRef.current = generation
    const previousSessionId = sessionIdRef.current
    sessionIdRef.current = null
    setSession(null)
    updateStatus('starting')
    setExitCode(null)
    setError(null)
    setProcessTitle('')
    if (previousSessionId != null) {
      await requireRepositoryApi().killTerminal(previousSessionId).catch(() => {})
    }
    if (resetBuffer) terminal.reset()

    try {
      fitRef.current?.()
      const nextSession = await requireRepositoryApi().createTerminal(terminal.cols, terminal.rows)
      if (disposedRef.current || generationRef.current !== generation) {
        await requireRepositoryApi().killTerminal(nextSession.id).catch(() => {})
        return
      }
      sessionIdRef.current = nextSession.id
      setSession(nextSession)
      updateStatus('running')
      requireRepositoryApi().readyTerminal(nextSession.id)
      window.requestAnimationFrame(() => terminal.focus())
    } catch (startError) {
      if (!disposedRef.current && generationRef.current === generation) {
        const message = getErrorMessage(startError)
        updateStatus('failed')
        setError(message)
        terminal.writeln(`\r\n\x1b[31mCould not start the project terminal.\x1b[0m ${message}`)
      }
    } finally {
      if (generationRef.current === generation) startingRef.current = false
    }
  }, [updateStatus])
  useImperativeHandle(ref, () => ({
    focus: () => {
      fitRef.current?.()
      terminalRef.current?.focus()
    }
  }), [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      startingRef.current = false
      generationRef.current += 1
      window.cancelAnimationFrame(resizeFrameRef.current)
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (sessionId != null) void requireRepositoryApi().killTerminal(sessionId).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const api = requireRepositoryApi()
    const unsubscribeData = api.onTerminalData((event) => {
      const terminal = terminalRef.current
      if (event.sessionId === sessionIdRef.current && terminal != null) writeTerminalOutput(terminal, event.data)
    })
    const unsubscribeExit = api.onTerminalExit((event) => {
      if (event.sessionId !== sessionIdRef.current) return
      sessionIdRef.current = null
      updateStatus('exited')
      setExitCode(event.exitCode)
      terminalRef.current?.writeln(`\r\n\x1b[2mProcess exited with code ${event.exitCode}. Press Enter to restart.\x1b[0m`)
    })
    return () => {
      unsubscribeData()
      unsubscribeExit()
    }
  }, [updateStatus])

  useTerminalInstance({
    containerRef,
    terminalRef,
    fitRef,
    sessionIdRef,
    statusRef,
    dragRef,
    settingsRef: initialSettingsRef,
    onTitleChange: setProcessTitle,
    restart: startTerminal
  })

  // A closed dock keeps its shell running, so main holds that output instead of
  // shipping it to a renderer that would parse and paint it for nobody.
  useEffect(() => {
    const sessionId = session?.id
    if (sessionId == null) return
    requireRepositoryApi().setTerminalVisibility(sessionId, open)
  }, [open, session])

  const settledSettings = useMemo(
    () => ({ fontFamily, fontSize, lineHeight, scrollback, theme }),
    [fontFamily, fontSize, lineHeight, scrollback, theme]
  )
  useDebouncedPersist(settledSettings, (settings) => {
    const terminal = terminalRef.current
    if (terminal == null) return
    terminal.options.fontFamily = settings.fontFamily
    terminal.options.fontSize = settings.fontSize
    terminal.options.lineHeight = settings.lineHeight
    terminal.options.scrollback = settings.scrollback
    terminal.options.theme = terminalThemeFor(settings.theme)
    fitRef.current?.()
  }, 150)

  useEffect(() => {
    if (!open) return
    // 'failed' is excluded deliberately: startTerminal flips status back to
    // 'starting' on entry, so retrying from here spun failure into a spawn loop.
    // Recovery goes through Restart or Enter instead.
    if (sessionIdRef.current == null && !startingRef.current &&
        status !== 'exited' && status !== 'failed') {
      void startTerminal(false)
    }
  }, [open, startTerminal, status])

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const range = event.shiftKey ? 48 : 16
    let nextHeight: number | null = null
    if (event.key === 'ArrowUp') nextHeight = clampTerminalHeight(height + range, window.innerHeight)
    if (event.key === 'ArrowDown') nextHeight = clampTerminalHeight(height - range, window.innerHeight)
    if (event.key === 'Home') nextHeight = clampTerminalHeight(0, window.innerHeight)
    if (event.key === 'End') nextHeight = clampTerminalHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)
    if (nextHeight == null) return
    event.preventDefault()
    onHeightChange(nextHeight)
    onHeightCommit(nextHeight)
  }

  const beginResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height }
    event.currentTarget.setPointerCapture(event.pointerId)
    onResizingChange(true)
  }

  const continueResize = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag == null || drag.pointerId !== event.pointerId) return
    const nextHeight = resistedTerminalHeight(drag.startHeight, drag.startY, event.clientY, window.innerHeight)
    window.cancelAnimationFrame(resizeFrameRef.current)
    resizeFrameRef.current = window.requestAnimationFrame(() => onHeightChange(nextHeight))
  }

  const finishResize = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag == null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.cancelAnimationFrame(resizeFrameRef.current)
    const nextHeight = resizedTerminalHeight(drag.startHeight, drag.startY, event.clientY, window.innerHeight)
    onHeightChange(nextHeight)
    onHeightCommit(nextHeight)
    onResizingChange(false)
    // The one fit of the drag, after the released height is committed.
    fitRef.current?.()
  }

  const statusLabel = terminalStatusLabel(status, session?.shell, exitCode)
  const contextLabel = processTitle.trim() || compactPath(session?.cwd ?? projectRoot)

  return (
    <section
      className="terminal-dock"
      data-state={status}
      aria-label={`Terminal for ${projectName}`}
      aria-hidden={!open}
      inert={!open}
    >
      <TerminalResizer
        height={height}
        onReset={() => {
          const nextHeight = clampTerminalHeight(260, window.innerHeight)
          onHeightChange(nextHeight)
          onHeightCommit(nextHeight)
        }}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={finishResize}
      />
      <TerminalHeader
        status={status}
        statusLabel={statusLabel}
        contextLabel={contextLabel}
        cwd={session?.cwd ?? projectRoot}
        shortcutLabel={shortcutLabel}
        onClear={() => {
          terminalRef.current?.clear()
          const sessionId = sessionIdRef.current
          if (sessionId != null) requireRepositoryApi().clearTerminal(sessionId)
          terminalRef.current?.focus()
        }}
        onRestart={() => void startTerminal(true)}
        onClose={onClose}
      />
      <div className="terminal-surface">
        <div className="terminal-viewport" ref={containerRef} />
        {error == null ? null : <div className="terminal-error" role="alert">{error}</div>}
      </div>
    </section>
  )
})

export default TerminalDock
