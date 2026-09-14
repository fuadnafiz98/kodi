import { describe, expect, test } from 'bun:test'
import type { IPty } from 'node-pty'

import type { TerminalDataEvent, TerminalExitEvent } from '../shared/contracts.js'
import {
  createTerminalEnvironment,
  posixLocaleValue,
  normalizeTerminalSize,
  resolveTerminalShell,
  TerminalService,
  type TerminalOwner
} from './terminalService.js'

function fakePty(): IPty & {
  emitData(data: string): void
  emitExit(exitCode: number): void
  writes: Array<string | Buffer>
  cleared: boolean
  killed: boolean
  paused: boolean
} {
  let dataListener: (data: string) => void = () => {}
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () => {}
  return {
    pid: 42,
    cols: 80,
    rows: 24,
    process: 'zsh',
    handleFlowControl: false,
    cleared: false,
    killed: false,
    paused: false,
    writes: [],
    onData(listener) {
      dataListener = listener
      return { dispose: () => { dataListener = () => {} } }
    },
    onExit(listener) {
      exitListener = listener
      return { dispose: () => { exitListener = () => {} } }
    },
    resize(columns, rows) {
      Object.assign(this, { cols: columns, rows })
    },
    clear() { this.cleared = true },
    write(data) { this.writes.push(data) },
    kill() { this.killed = true },
    pause() { this.paused = true },
    resume() { this.paused = false },
    emitData(data) { dataListener(data) },
    emitExit(exitCode) { exitListener({ exitCode }) }
  }
}

function fakeOwner(id: number): TerminalOwner & {
  events: Array<{ channel: string; payload: TerminalDataEvent | TerminalExitEvent }>
  destroy(): void
} {
  let destroyed = false
  let destroyListener = (): void => {}
  return {
    id,
    events: [],
    isDestroyed: () => destroyed,
    send(channel, payload) { this.events.push({ channel, payload }) },
    once(_event, listener) { destroyListener = listener },
    destroy() {
      destroyed = true
      destroyListener()
    }
  }
}

describe('terminal configuration', () => {
  test('uses the configured login shell and a safe fallback', () => {
    expect(resolveTerminalShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, () => true))
      .toEqual({ executable: '/opt/homebrew/bin/fish', args: ['-l'], label: 'fish' })
    expect(resolveTerminalShell('darwin', { SHELL: 'relative-shell' }, (path) => path === '/bin/zsh'))
      .toEqual({ executable: '/bin/zsh', args: ['-l'], label: 'zsh' })
  })

  test('sets terminal metadata without leaking Electron child-process flags', () => {
    const environment = createTerminalEnvironment('/work/project', '1.2.3', {
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      GOOGLE_API_KEY: 'internal'
    })
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(environment.GOOGLE_API_KEY).toBeUndefined()
    expect(environment.TERM).toBe('xterm-256color')
    expect(environment.TERM_PROGRAM).toBe('Kodi')
  })

  test('hands the shell a locale it can set', () => {
    // macOS gives a GUI app its own locale identifier, and a login shell answers
    // with `setlocale: LC_ALL: cannot change locale` on every new terminal.
    const environment = createTerminalEnvironment('/work/project', '1.2.3', {
      LC_ALL: 'en-US-u-ca-gregory-co-standard-cu-usd-fw-sun-hc-h12-ms-metric-tz-deber',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'de-DE',
      LC_TIME: 'not a locale at all'
    })
    expect(environment.LC_ALL).toBe('en_US.UTF-8')
    expect(environment.LANG).toBe('en_US.UTF-8')
    expect(environment.LC_CTYPE).toBe('de_DE.UTF-8')
    // Nothing to recover: dropping it lets the shell fall back to LANG rather
    // than inheriting a value it has already refused.
    expect(environment.LC_TIME).toBeUndefined()
  })

  test('keeps locales a shell already accepts exactly as they are', () => {
    expect(posixLocaleValue('en_US.UTF-8')).toBe('en_US.UTF-8')
    expect(posixLocaleValue('C')).toBe('C')
    expect(posixLocaleValue('POSIX')).toBe('POSIX')
    expect(posixLocaleValue('pt_BR.ISO8859-1')).toBe('pt_BR.ISO8859-1')
    expect(posixLocaleValue('sr_RS.UTF-8@latin')).toBe('sr_RS.UTF-8@latin')
    expect(posixLocaleValue('zh-Hans-CN')).toBe('zh_CN.UTF-8')
    expect(posixLocaleValue('  ')).toBeNull()
  })

  test('rejects malformed or excessive dimensions', () => {
    expect(normalizeTerminalSize(120, 40)).toEqual({ columns: 120, rows: 40 })
    expect(() => normalizeTerminalSize(0, 40)).toThrow()
    expect(() => normalizeTerminalSize(80.5, 40)).toThrow()
    expect(() => normalizeTerminalSize(80, 500)).toThrow()
  })
})

describe('TerminalService', () => {
  test('scopes input to its renderer and waits for renderer readiness before output', async () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    const otherOwner = fakeOwner(2)
    const service = new TerminalService(() => pty)
    const session = await service.create(owner, process.cwd(), 80, 24, '0.1.0')

    expect(pty.paused).toBe(true)
    pty.emitData('prompt')
    expect(owner.events).toHaveLength(0)
    service.write(otherOwner.id, session.id, 'blocked')
    service.write(owner.id, session.id, 'accepted')
    expect(pty.writes).toEqual(['accepted'])

    service.ready(owner.id, session.id)
    pty.emitData(' ready')
    await Bun.sleep(15)
    expect(pty.paused).toBe(false)
    expect(owner.events.at(-1)?.payload).toEqual({ sessionId: session.id, data: 'prompt ready' })

    owner.destroy()
    expect(pty.killed).toBe(true)
  })

  test('resizes, clears, reports exit, and rejects work after exit', async () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    const service = new TerminalService(() => pty)
    const session = await service.create(owner, process.cwd(), 80, 24, '0.1.0')

    service.resize(owner.id, session.id, 120, 36)
    service.clear(owner.id, session.id)
    expect({ columns: pty.cols, rows: pty.rows, cleared: pty.cleared })
      .toEqual({ columns: 120, rows: 36, cleared: true })

    service.ready(owner.id, session.id)
    pty.emitExit(7)
    expect(owner.events.at(-1)?.payload).toEqual({ sessionId: session.id, exitCode: 7 })

    service.write(owner.id, session.id, 'ignored')
    service.resize(owner.id, session.id, 90, 20)
    expect(pty.writes).toHaveLength(0)
    expect({ columns: pty.cols, rows: pty.rows }).toEqual({ columns: 120, rows: 36 })
  })

  test('captures output emitted before the session is published', async () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    // A subscription registered after the map insert would drop this chunk and
    // dispose a null on kill; emitting from the spawn call proves the order.
    const service = new TerminalService(() => {
      queueMicrotask(() => pty.emitData('immediate'))
      return pty
    })

    const session = await service.create(owner, process.cwd(), 80, 24, '0.1.0')
    service.ready(owner.id, session.id)
    pty.emitData(' flushed')
    await Bun.sleep(15)

    expect(owner.events.at(-1)?.payload).toEqual({ sessionId: session.id, data: 'immediate flushed' })
    expect(() => { service.kill(owner.id, session.id) }).not.toThrow()
  })

  test('holds output while the dock is hidden and replays the tail on show', async () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    const service = new TerminalService(() => pty)
    const session = await service.create(owner, process.cwd(), 80, 24, '0.1.0')
    service.ready(owner.id, session.id)

    service.setVisible(owner.id, session.id, false)
    pty.emitData('hidden output')
    await Bun.sleep(15)
    expect(owner.events).toHaveLength(0)

    service.setVisible(owner.id, session.id, true)
    expect(owner.events.at(-1)?.payload).toEqual({ sessionId: session.id, data: 'hidden output' })
  })

  test('caps what a hidden session buffers instead of growing without bound', async () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    const service = new TerminalService(() => pty)
    const session = await service.create(owner, process.cwd(), 80, 24, '0.1.0')
    service.ready(owner.id, session.id)
    service.setVisible(owner.id, session.id, false)

    for (let index = 0; index < 12; index += 1) pty.emitData('x'.repeat(100_000))
    service.setVisible(owner.id, session.id, true)

    const payload = owner.events.at(-1)?.payload as TerminalDataEvent
    expect(payload.data).toHaveLength(512 * 1_024)
  })
})
