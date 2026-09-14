import { describe, expect, it } from 'bun:test'

import {
  COMMAND_ABORTED_MESSAGE,
  COMMAND_EXECUTION_TIMEOUT_MESSAGE,
  COMMAND_QUEUE_TIMEOUT_MESSAGE,
  commandSemaphore,
  CommandSemaphore,
  comparePaths,
  MAX_BACKGROUND_COMMANDS,
  MAX_CONCURRENT_COMMANDS,
  awaitAll,
  mapWithConcurrency,
  runCommand,
  splitNullDelimited
} from './gitCommands.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function settled<Value>(promise: Promise<Value>): { done: () => boolean } {
  let done = false
  void promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  return { done: () => done }
}

describe('runCommand', () => {
  it('turns git\'s optional index lock off for every child', async () => {
    const result = await runCommand('/bin/sh', ['-c', 'printf %s "$GIT_OPTIONAL_LOCKS"'])
    expect(result.stdout.toString('utf8')).toBe('0')
  })

  it('keeps the rest of the environment', async () => {
    const result = await runCommand('/bin/sh', ['-c', 'printf %s "$PATH"'])
    expect(result.stdout.toString('utf8')).toBe(process.env.PATH ?? '')
  })

  it('reports an aborted command instead of its output', async () => {
    const abort = new AbortController()
    const command = runCommand('/bin/sh', ['-c', 'sleep 5'], undefined, [], undefined, abort.signal)
    abort.abort()

    await expect(command).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
  })

  it('kills a child at its execution deadline and releases the command slot', async () => {
    const runningBefore = commandSemaphore.running
    const command = runCommand(
      '/bin/sh', ['-c', 'sleep 5'], undefined, [], undefined, undefined, 'interactive',
      { executionMs: 20 }
    )
    await expect(command).rejects.toThrow(COMMAND_EXECUTION_TIMEOUT_MESSAGE)
    // Other test files also use the process-wide semaphore and can finish while
    // this command runs. This command must not leave an additional slot occupied.
    expect(commandSemaphore.running).toBeLessThanOrEqual(runningBefore)
  })
})

describe('CommandSemaphore', () => {
  it('runs at most `limit` commands at a time', async () => {
    const semaphore = new CommandSemaphore(2, 2)
    const first = await semaphore.acquire('interactive')
    await semaphore.acquire('interactive')
    const third = settled(semaphore.acquire('interactive'))

    expect(semaphore.running).toBe(2)
    expect(semaphore.waiting).toBe(1)
    await delay(0)
    expect(third.done()).toBe(false)

    first()
    await delay(0)
    expect(third.done()).toBe(true)
    expect(semaphore.running).toBe(2)
  })

  it('admits waiters of one lane in the order they asked', async () => {
    const semaphore = new CommandSemaphore(1, 1)
    const held = await semaphore.acquire('interactive')
    const order: string[] = []
    const first = semaphore.acquire('interactive').then((release) => {
      order.push('first')
      release()
    })
    const second = semaphore.acquire('interactive').then((release) => {
      order.push('second')
      release()
    })

    held()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('admits a waiting interactive command before a background one that asked first', async () => {
    const semaphore = new CommandSemaphore(1, 1)
    const held = await semaphore.acquire('interactive')
    const order: string[] = []
    const background = semaphore.acquire('background').then((release) => {
      order.push('background')
      release()
    })
    const interactive = semaphore.acquire('interactive').then((release) => {
      order.push('interactive')
      release()
    })

    held()
    await Promise.all([background, interactive])
    expect(order).toEqual(['interactive', 'background'])
  })

  it('keeps slots the background lane cannot take', async () => {
    const semaphore = new CommandSemaphore(3, 1)
    await semaphore.acquire('background')
    const queued = settled(semaphore.acquire('background'))
    await delay(0)

    expect(queued.done()).toBe(false)
    expect(semaphore.backgroundRunning).toBe(1)

    const interactive = await semaphore.acquire('interactive')
    expect(semaphore.running).toBe(2)
    interactive()
  })

  it('promotes a queued background waiter whose lane source flips to interactive', async () => {
    const semaphore = new CommandSemaphore(2, 1)
    const background = await semaphore.acquire('background')
    const interactive = await semaphore.acquire('interactive')
    let promoted = false
    const queued = settled(semaphore.acquire(() => (promoted ? 'interactive' : 'background')))
    await delay(0)

    expect(queued.done()).toBe(false)
    expect(semaphore.waiting).toBe(1)

    // An interactive slot freeing does not admit it while it still reads
    // background: the background lane is already at its limit.
    interactive()
    await delay(0)
    expect(queued.done()).toBe(false)
    expect(semaphore.running).toBe(1)

    // Once the source resolves interactive the grant lands on the interactive
    // pass, so it never occupies the background slot it queued for.
    promoted = true
    background()
    await delay(0)
    expect(queued.done()).toBe(true)
    expect(semaphore.backgroundRunning).toBe(0)
    expect(semaphore.running).toBe(1)
  })

  it('drops a waiting command when its signal aborts', async () => {
    const semaphore = new CommandSemaphore(1, 1)
    const held = await semaphore.acquire('interactive')
    const abort = new AbortController()
    const waiting = semaphore.acquire('interactive', abort.signal)

    expect(semaphore.waiting).toBe(1)
    abort.abort()

    await expect(waiting).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
    expect(semaphore.waiting).toBe(0)

    held()
    expect(semaphore.running).toBe(0)
  })

  it('refuses a command whose signal already aborted', async () => {
    const semaphore = new CommandSemaphore(2, 1)
    await expect(semaphore.acquire('interactive', AbortSignal.abort())).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
    expect(semaphore.running).toBe(0)
  })

  it('hands a slot back only once however often the release is called', async () => {
    const semaphore = new CommandSemaphore(1, 1)
    const release = await semaphore.acquire('interactive')
    release()
    release()

    expect(semaphore.running).toBe(0)
  })

  it('reserves interactive slots on this machine', () => {
    expect(MAX_CONCURRENT_COMMANDS).toBeGreaterThanOrEqual(4)
    expect(MAX_BACKGROUND_COMMANDS).toBeLessThanOrEqual(MAX_CONCURRENT_COMMANDS)
  })
})

describe('runCommand admission', () => {
  it('waits for a slot on the shared semaphore before spawning', async () => {
    const held = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_COMMANDS }, () => commandSemaphore.acquire('interactive'))
    )
    try {
      const command = runCommand('/bin/sh', ['-c', 'exit 0'])
      const state = settled(command)
      await delay(30)
      expect(state.done()).toBe(false)
      expect(commandSemaphore.waiting).toBe(1)

      for (const release of held) release()
      await command
      expect(state.done()).toBe(true)
    } finally {
      for (const release of held) release()
    }
  })

  it('expires while queued without spawning or consuming a slot', async () => {
    const held = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_COMMANDS }, () => commandSemaphore.acquire('interactive'))
    )
    try {
      const command = runCommand(
        '/bin/sh', ['-c', 'exit 0'], undefined, [], undefined, undefined, 'interactive',
        { queueMs: 20 }
      )
      await expect(command).rejects.toThrow(COMMAND_QUEUE_TIMEOUT_MESSAGE)
      expect(commandSemaphore.running).toBe(MAX_CONCURRENT_COMMANDS)
    } finally {
      for (const release of held) release()
    }
  })
})

describe('splitNullDelimited', () => {
  it('drops the trailing empty field git leaves behind', () => {
    expect(splitNullDelimited(Buffer.from('a\0b\0'))).toEqual(['a', 'b'])
    expect(splitNullDelimited(Buffer.alloc(0))).toEqual([])
  })
})

describe('comparePaths', () => {
  it('orders by byte value so git and the snapshot agree', () => {
    expect(['b', 'A', 'a'].sort(comparePaths)).toEqual(['A', 'a', 'b'])
  })
})

describe('awaitAll', () => {
  it('does not leave sibling rejections unhandled when every promise fails', async () => {
    const abort = new AbortController()
    const first = runCommand('/bin/sh', ['-c', 'sleep 5'], undefined, [], undefined, abort.signal)
    const second = runCommand('/bin/sh', ['-c', 'sleep 5'], undefined, [], undefined, abort.signal)
    const third = runCommand('/bin/sh', ['-c', 'sleep 5'], undefined, [], undefined, abort.signal)
    abort.abort()
    await expect(awaitAll([first, second, third])).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
  })
})

describe('mapWithConcurrency', () => {
  it('does not leave sibling rejections unhandled when every worker fails', async () => {
    const abort = new AbortController()
    const started: Promise<void>[] = []
    const work = mapWithConcurrency([1, 2, 3, 4], 4, () => {
      const command = runCommand(
        '/bin/sh',
        ['-c', 'sleep 5'],
        undefined,
        [],
        undefined,
        abort.signal
      )
      started.push(command.then(() => undefined, () => undefined))
      return command.then(() => undefined)
    })
    abort.abort()
    await expect(work).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
    await Promise.all(started)
  })
})
