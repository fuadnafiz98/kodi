import { execFile, spawn } from 'node:child_process'
import { cpus } from 'node:os'

import { COMMAND_ABORTED_MESSAGE } from '../shared/contracts.js'

export { COMMAND_ABORTED_MESSAGE }

export const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
export const COMMAND_QUEUE_TIMEOUT_MESSAGE = 'The command timed out while waiting for capacity.'
export const COMMAND_EXECUTION_TIMEOUT_MESSAGE = 'The command exceeded its execution deadline.'
const INTERACTIVE_QUEUE_TIMEOUT_MS = 30_000
const BACKGROUND_QUEUE_TIMEOUT_MS = 60_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000

export interface CommandDeadlineOptions {
  queueMs?: number
  executionMs?: number
}

function deadlineSignal(
  upstream: AbortSignal | undefined,
  milliseconds: number,
  message: string
): { signal: AbortSignal; dispose(): void; timedOut(): boolean } {
  const controller = new AbortController()
  let deadlineReached = false
  const abort = (): void => controller.abort()
  if (upstream?.aborted) controller.abort()
  else upstream?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    deadlineReached = true
    controller.abort()
  }, Math.max(1, milliseconds))
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      upstream?.removeEventListener('abort', abort)
    },
    timedOut: () => deadlineReached && !upstream?.aborted && message !== ''
  }
}

/**
 * A plain `git status` takes the optional index lock and rewrites `.git/index`,
 * which the repository watcher reads as a change and answers with another
 * refresh: one `touch README.md` produced three refresh cycles and 11.3 s of
 * saturated core. `GIT_OPTIONAL_LOCKS=0` is `--no-optional-locks` for every
 * subcommand, including the ones `gh` runs for us.
 */
function commandEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
}

export interface CommandResult {
  stdout: Buffer
  stderr: Buffer
}

export function splitNullDelimited(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export interface GitObjectRead {
  contents: Buffer | null
  oid: string
  type: string
  size: number
  missing: boolean
  oversized: boolean
}

const MAX_CAT_FILE_HEADER_BYTES = 4_096
const GIT_OBJECT_READER_IDLE_MS = 60_000
const GIT_OBJECT_READ_TIMEOUT_MS = 30_000
const MISSING_GIT_OBJECT: GitObjectRead = {
  contents: null,
  oid: '',
  type: 'missing',
  size: 0,
  missing: true,
  oversized: false
}

interface PendingGitObjectRead {
  object: string
  resolve(value: GitObjectRead): void
  reject(error: Error): void
}

/**
 * One long-lived `git cat-file --batch` per repository instead of one per blob.
 * Measured on this repository, 60 HEAD blobs cost 1113 ms through a spawn per
 * read and 39 ms through a single batch process — the fork/exec of git, not the
 * object lookup, was the whole cost.
 *
 * `--batch` answers `<oid> <type> <size>\n<contents>\n`, so the reader is a
 * strict FIFO: every request consumes exactly one record. A record is therefore
 * never abandoned part-read — an oversized blob is drained and discarded rather
 * than killing the child, because killing mid-record would hand the next
 * request the wrong file's bytes.
 */
export class GitObjectReader {
  #root: string
  #child: ReturnType<typeof spawn> | null = null
  #queue: PendingGitObjectRead[] = []
  #buffer: Buffer = Buffer.alloc(0)
  #pendingBody: { received: number; expected: number; chunks: Buffer[] | null; header: GitObjectRead } | null = null
  #stderr = ''
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  #readTimer: ReturnType<typeof setTimeout> | null = null
  #spawns = 0

  constructor(root: string) {
    this.#root = root
  }

  get spawnCountForTests(): number {
    return this.#spawns
  }

  read(object: string): Promise<GitObjectRead> {
    if (object.includes('\n')) return Promise.reject(new Error('Git object names cannot contain newlines.'))
    return new Promise<GitObjectRead>((resolveRead, rejectRead) => {
      this.#queue.push({ object, resolve: resolveRead, reject: rejectRead })
      const child = this.#ensureChild()
      if (child == null) return
      this.#armTimers()
      child.stdin?.write(`${object}\n`)
    })
  }

  dispose(): void {
    this.#failAll(new Error('The repository was closed while reading a Git object.'))
    this.#clearTimers()
    const child = this.#child
    this.#child = null
    this.#buffer = Buffer.alloc(0)
    this.#pendingBody = null
    child?.kill()
  }

  #ensureChild(): ReturnType<typeof spawn> | null {
    if (this.#child != null) return this.#child
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['-C', this.#root, 'cat-file', '--batch'], {
        env: commandEnvironment(),
        windowsHide: true
      })
    } catch (error) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)))
      return null
    }
    this.#spawns += 1
    this.#child = child
    this.#stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.#child !== child) return
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
      this.#drain(child)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(-2_048)
    })
    child.stdin?.on('error', () => {})
    const abandon = (): void => {
      if (this.#child !== child) return
      this.#child = null
      this.#buffer = Buffer.alloc(0)
      this.#pendingBody = null
      this.#failAll(new Error(this.#stderr.trim() || 'git cat-file did not return the object.'))
      this.#clearTimers()
    }
    child.on('error', abandon)
    child.on('close', abandon)
    return child
  }

  // A stream that no longer lines up with the queue would answer the next
  // request with the previous file's bytes, so any parse anomaly restarts the
  // child rather than trying to resynchronise.
  #restart(child: ReturnType<typeof spawn>, error: Error): void {
    if (this.#child !== child) return
    this.#child = null
    this.#buffer = Buffer.alloc(0)
    this.#pendingBody = null
    child.kill()
    this.#failAll(error)
    this.#clearTimers()
  }

  #drain(child: ReturnType<typeof spawn>): void {
    for (;;) {
      const body = this.#pendingBody
      if (body != null) {
        const remaining = body.expected - body.received
        if (this.#buffer.length === 0) return
        const take = Math.min(remaining, this.#buffer.length)
        if (body.chunks != null) body.chunks.push(this.#buffer.subarray(0, take))
        body.received += take
        this.#buffer = this.#buffer.subarray(take)
        if (body.received < body.expected) return
        this.#pendingBody = null
        const contents = body.chunks == null
          ? null
          : Buffer.concat(body.chunks).subarray(0, body.header.size)
        this.#settle({ ...body.header, contents })
        continue
      }

      const newline = this.#buffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.#buffer.length > MAX_CAT_FILE_HEADER_BYTES) {
          this.#restart(child, new Error('git cat-file returned no header.'))
        }
        return
      }
      const fields = this.#buffer.subarray(0, newline).toString('utf8').split(' ')
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (fields[1] === 'missing' || fields.length < 3) {
        this.#settle(MISSING_GIT_OBJECT)
        continue
      }
      const size = Number(fields[2])
      if (!Number.isFinite(size) || size < 0) {
        this.#restart(child, new Error('git cat-file returned an unreadable size.'))
        return
      }
      const oversized = size > MAX_DIFF_FILE_BYTES
      this.#pendingBody = {
        received: 0,
        // The record is the contents plus the newline git appends after them.
        expected: size + 1,
        chunks: oversized ? null : [],
        header: {
          contents: null,
          oid: fields[0] ?? '',
          type: fields[1] ?? '',
          size,
          missing: false,
          oversized
        }
      }
    }
  }

  #settle(value: GitObjectRead): void {
    const pending = this.#queue.shift()
    pending?.resolve(value)
    this.#armTimers()
  }

  #failAll(error: Error): void {
    const queue = this.#queue
    this.#queue = []
    for (const pending of queue) pending.reject(error)
  }

  #armTimers(): void {
    if (this.#idleTimer != null) clearTimeout(this.#idleTimer)
    if (this.#readTimer != null) clearTimeout(this.#readTimer)
    this.#idleTimer = null
    this.#readTimer = null
    if (this.#queue.length > 0) {
      this.#readTimer = setTimeout(() => {
        const child = this.#child
        if (child != null) this.#restart(child, new Error('git cat-file stopped responding.'))
      }, GIT_OBJECT_READ_TIMEOUT_MS)
      this.#readTimer.unref?.()
      return
    }
    this.#idleTimer = setTimeout(() => {
      const child = this.#child
      this.#child = null
      this.#buffer = Buffer.alloc(0)
      this.#pendingBody = null
      child?.kill()
    }, GIT_OBJECT_READER_IDLE_MS)
    this.#idleTimer.unref?.()
  }

  #clearTimers(): void {
    if (this.#idleTimer != null) clearTimeout(this.#idleTimer)
    if (this.#readTimer != null) clearTimeout(this.#readTimer)
    this.#idleTimer = null
    this.#readTimer = null
  }
}

export async function readGitObject(root: string, object: string): Promise<GitObjectRead> {
  const reader = new GitObjectReader(root)
  try {
    return await reader.read(object)
  } finally {
    reader.dispose()
  }
}

/**
 * Git, gh and ripgrep children all fork/exec a process that then walks the
 * filesystem, so running more of them than the machine has spare cores makes
 * every one of them slower: during a Cmd+H, 307 `git remote -v` probes running
 * eight wide against a four-way ignored walk each cost 3-6x their idle time.
 *
 * The interactive lane is work somebody is waiting on — refreshing the active
 * root, opening a pull request, searching, reading a file. The background lane is
 * speculative: pull request warmup, remote probing, ignored listings for
 * repositories nobody is looking at.
 */
export type CommandLane = 'interactive' | 'background'

/**
 * Callers whose priority can change mid-flight pass a source instead of a
 * fixed lane: it is read at admission time and again when the waiter's slot is
 * granted, so work queued as background can promote while it waits. A
 * pull-request warmup is the case — a foreground reader joining it attaches,
 * and every later hop resolves 'interactive' from that point on.
 */
export type CommandLaneSource = CommandLane | (() => CommandLane)

export function resolveCommandLane(source: CommandLaneSource): CommandLane {
  return typeof source === 'function' ? source() : source
}

export const MAX_CONCURRENT_COMMANDS = Math.max(4, cpus().length - 2)
/**
 * Lane priority only orders the queue. A background burst that already filled
 * every slot would still make the next interactive command wait for a child to
 * exit, so two slots are held back for the interactive lane.
 */
export const MAX_BACKGROUND_COMMANDS = Math.max(1, MAX_CONCURRENT_COMMANDS - 2)

interface CommandWaiter {
  lane: CommandLaneSource
  grant(): void
}

/**
 * Admission control for command children: at most `limit` at a time, of which at
 * most `backgroundLimit` are background. Waiting interactive commands are always
 * admitted before waiting background ones, and a waiter whose signal aborts
 * leaves the queue instead of spawning when its turn finally comes.
 */
export class CommandSemaphore {
  #limit: number
  #backgroundLimit: number
  #running = 0
  #backgroundRunning = 0
  #interactiveQueue: CommandWaiter[] = []
  #backgroundQueue: CommandWaiter[] = []

  constructor(limit: number = MAX_CONCURRENT_COMMANDS, backgroundLimit: number = MAX_BACKGROUND_COMMANDS) {
    this.#limit = Math.max(1, limit)
    this.#backgroundLimit = Math.max(1, Math.min(this.#limit, backgroundLimit))
  }

  get running(): number {
    return this.#running
  }

  get backgroundRunning(): number {
    return this.#backgroundRunning
  }

  get waiting(): number {
    return this.#interactiveQueue.length + this.#backgroundQueue.length
  }

  /** Resolves with the function that hands the slot back. Calling it twice is a no-op. */
  acquire(source: CommandLaneSource, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(new Error(COMMAND_ABORTED_MESSAGE))
    if (this.#hasSlot(resolveCommandLane(source))) return Promise.resolve(this.#take(resolveCommandLane(source)))
    return new Promise<() => void>((resolveSlot, rejectSlot) => {
      const queue = resolveCommandLane(source) === 'interactive' ? this.#interactiveQueue : this.#backgroundQueue
      // Assigned before the waiter can be granted: a grant only ever comes from
      // another command releasing its slot, which cannot happen synchronously here.
      let detach = (): void => {}
      const waiter: CommandWaiter = {
        lane: source,
        grant: () => {
          detach()
          resolveSlot(this.#take(resolveCommandLane(source)))
        }
      }
      queue.push(waiter)
      if (signal == null) return
      const onAbort = (): void => {
        const index = queue.indexOf(waiter)
        if (index !== -1) queue.splice(index, 1)
        rejectSlot(new Error(COMMAND_ABORTED_MESSAGE))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      detach = () => signal.removeEventListener('abort', onAbort)
    })
  }

  #hasSlot(lane: CommandLane): boolean {
    if (this.#running >= this.#limit) return false
    return lane === 'interactive' || this.#backgroundRunning < this.#backgroundLimit
  }

  #take(lane: CommandLane): () => void {
    this.#running += 1
    if (lane === 'background') this.#backgroundRunning += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#running -= 1
      if (lane === 'background') this.#backgroundRunning -= 1
      this.#pump()
    }
  }

  #pump(): void {
    for (;;) {
      const waiter = this.#nextWaiter()
      if (waiter == null) return
      waiter.grant()
    }
  }

  #nextWaiter(): CommandWaiter | null {
    if (!this.#hasSlot('interactive')) return null
    const interactive = this.#interactiveQueue.shift()
    if (interactive != null) return interactive
    // A deferred lane is read again at grant time, so a waiter that queued as
    // background but now resolves interactive is admitted on this pass instead
    // of waiting for a background slot that may never free up.
    const promotedIndex = this.#backgroundQueue.findIndex(
      (waiter) => resolveCommandLane(waiter.lane) === 'interactive'
    )
    if (promotedIndex !== -1) return this.#backgroundQueue.splice(promotedIndex, 1)[0] ?? null
    if (!this.#hasSlot('background')) return null
    return this.#backgroundQueue.shift() ?? null
  }
}

/** The one semaphore every `runCommand` child passes through. */
export const commandSemaphore = new CommandSemaphore()

export async function runCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
  allowedExitCodes: readonly number[] = [],
  input?: string,
  signal?: AbortSignal,
  lane: CommandLaneSource = 'interactive',
  deadlines: CommandDeadlineOptions = {}
): Promise<CommandResult> {
  const resolvedLane = resolveCommandLane(lane)
  const queueDeadline = deadlineSignal(
    signal,
    deadlines.queueMs ?? (resolvedLane === 'interactive' ? INTERACTIVE_QUEUE_TIMEOUT_MS : BACKGROUND_QUEUE_TIMEOUT_MS),
    COMMAND_QUEUE_TIMEOUT_MESSAGE
  )
  let release: () => void
  try {
    release = await commandSemaphore.acquire(lane, queueDeadline.signal)
  } catch (error) {
    if (queueDeadline.timedOut()) throw new Error(COMMAND_QUEUE_TIMEOUT_MESSAGE)
    throw error
  } finally {
    queueDeadline.dispose()
  }
  const executionDeadline = deadlineSignal(
    signal,
    deadlines.executionMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    COMMAND_EXECUTION_TIMEOUT_MESSAGE
  )
  try {
    return await spawnCommand(executable, args, cwd, allowedExitCodes, input, executionDeadline.signal)
  } catch (error) {
    if (executionDeadline.timedOut()) throw new Error(COMMAND_EXECUTION_TIMEOUT_MESSAGE)
    throw error
  } finally {
    executionDeadline.dispose()
    release()
  }
}

function spawnCommand(
  executable: string,
  args: readonly string[],
  cwd: string | undefined,
  allowedExitCodes: readonly number[],
  input: string | undefined,
  signal: AbortSignal | undefined
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    if (signal?.aborted === true) {
      rejectCommand(new Error(COMMAND_ABORTED_MESSAGE))
      return
    }
    const child = execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        env: commandEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        signal
      },
      (error, stdout, stderr) => {
        const result = { stdout, stderr }
        if (signal?.aborted === true) {
          rejectCommand(new Error(COMMAND_ABORTED_MESSAGE))
          return
        }

        const exitCode = error == null ? 0 : Number(error.code)
        if (error && !allowedExitCodes.includes(exitCode)) {
          const message = result.stderr.toString('utf8').trim() || error.message
          rejectCommand(new Error(message))
          return
        }

        resolveCommand(result)
      }
    )
    if (input != null) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

/** Wait for every promise so a shared abort cannot leave sibling rejections unhandled. */
export async function awaitAll<Values extends readonly unknown[]>(
  promises: [...{ [Index in keyof Values]: Promise<Values[Index]> }]
): Promise<Values> {
  const settled = await Promise.allSettled(promises)
  for (const item of settled) {
    if (item.status === 'rejected') throw item.reason
  }
  return settled.map((item) => (item as PromiseFulfilledResult<unknown>).value) as unknown as Values
}

export async function mapWithConcurrency<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  transform: (value: Value) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = []
  results.length = values.length
  let nextIndex = 0
  let failed = false
  let firstError: unknown
  const runNext = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      try {
        results[index] = await transform(values[index]!)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
        return
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runNext())
  )
  if (failed) throw firstError
  return results
}
