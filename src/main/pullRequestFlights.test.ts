import { describe, expect, test } from 'bun:test'

import type { PullRequestReview, PullRequestReviewProgress } from '../shared/contracts.js'
import { PullRequestReviewFlight, ReviewFlight } from './pullRequestFlights.js'

const review = (overrides: Partial<PullRequestReview> = {}): PullRequestReview => ({
  kind: 'github',
  selector: 'https://github.com/acme/app/pull/7',
  baseOid: 'base',
  headOid: 'head',
  commitId: 'head',
  viewerCanSubmitDecision: true,
  pullRequest: {
    number: 7,
    title: 'Add a thing',
    url: 'https://github.com/acme/app/pull/7',
    state: 'open',
    isDraft: false,
    author: { login: 'author' },
    headRefName: 'feature',
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-17T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1
  },
  files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
  patch: 'diff --git a/src/a.ts b/src/a.ts\n',
  omittedFiles: [],
  expectedFileCount: 1,
  ...overrides
})

const metadata = (): PullRequestReviewProgress =>
  ({ kind: 'metadata', selector: 'pr', review: review({ files: [], patch: '' }) })

const page = (patch: string): PullRequestReviewProgress =>
  ({ kind: 'files', selector: 'pr', patch, files: [], omittedFiles: [] })

const done = (): PullRequestReviewProgress => ({ kind: 'done', selector: 'pr', fileCount: 1 })

const checks = (): PullRequestReviewProgress =>
  ({ kind: 'checks', selector: 'pr', checks: { passing: 2, failing: 0, pending: 1 }, mergeable: 'MERGEABLE' })

const kinds = (events: readonly PullRequestReviewProgress[]): string[] => events.map((event) => event.kind)

// A box rather than a `let`: the assignment happens inside the callback the flight
// invokes, which narrowing does not follow.
const emitter = (): { send: ((progress: PullRequestReviewProgress) => void) | null } => ({ send: null })

describe('PullRequestReviewFlight', () => {
  test('fans an event out to every subscriber', async () => {
    const flight = new PullRequestReviewFlight()
    const first: PullRequestReviewProgress[] = []
    const second: PullRequestReviewProgress[] = []
    flight.join((progress) => first.push(progress))
    const captured = emitter()
    const promise = flight.start(async (send) => {
      captured.send = send
      send(metadata())
      return review()
    })
    flight.join((progress) => second.push(progress))
    captured.send?.(page('a'))
    await promise

    expect(kinds(first)).toEqual(['metadata', 'files'])
    expect(kinds(second)).toEqual(['metadata', 'files'])
  })

  test('replays metadata and every page to a caller that joins late', async () => {
    const flight = new PullRequestReviewFlight()
    await flight.start(async (send) => {
      send(metadata())
      send(page('a'))
      send(page('b'))
      send(checks())
      send(done())
      return review()
    })

    const late: PullRequestReviewProgress[] = []
    flight.join((progress) => late.push(progress))
    expect(kinds(late)).toEqual(['metadata', 'files', 'files', 'checks', 'done'])
    expect(late.filter((event) => event.kind === 'files').map((event) => event.patch)).toEqual(['a', 'b'])
  })

  test('replays a revision notice without replacing frozen pages', async () => {
    const flight = new PullRequestReviewFlight()
    await flight.start(async (send) => {
      send(metadata())
      send(page('stale'))
      send({
        kind: 'revisionAvailable',
        selector: 'pr',
        snapshotIdentity: {
          formatEpoch: 1,
          host: 'github.com',
          repository: 'acme/app',
          number: 1,
          baseRefName: 'main',
          baseOid: 'base-2',
          headRefName: 'feature',
          headOid: 'head-2',
          effectiveBaseOid: 'base-2',
          patchSource: 'github'
        }
      })
      send(done())
      return review({ patch: 'fresh' })
    })

    expect(kinds(flight.replay())).toEqual(['metadata', 'files', 'revisionAvailable', 'done'])
  })

  test('marks itself streamed only once a page has been emitted', async () => {
    const flight = new PullRequestReviewFlight()
    expect(flight.streamed).toBe(false)
    await flight.start(async (send) => {
      send(metadata())
      return review()
    })
    expect(flight.streamed).toBe(false)

    const streaming = new PullRequestReviewFlight()
    await streaming.start(async (send) => {
      send(metadata())
      send(page('a'))
      return review()
    })
    expect(streaming.streamed).toBe(true)
  })

  test('keeps delivering after a subscriber throws, and stops for a released one', async () => {
    const flight = new PullRequestReviewFlight()
    const received: PullRequestReviewProgress[] = []
    const released: PullRequestReviewProgress[] = []
    const releasedListener = (progress: PullRequestReviewProgress): void => {
      released.push(progress)
    }
    flight.join(() => {
      throw new Error('window closed')
    })
    flight.join(releasedListener)
    flight.join((progress) => received.push(progress))

    const captured = emitter()
    const promise = flight.start(async (send) => {
      captured.send = send
      send(metadata())
      return review()
    })
    flight.release(releasedListener)
    captured.send?.(page('a'))
    await promise

    expect(kinds(received)).toEqual(['metadata', 'files'])
    expect(kinds(released)).toEqual(['metadata'])
  })

  test('runs the fetch once however many times start is called', async () => {
    const flight = new PullRequestReviewFlight()
    let runs = 0
    const run = async (): Promise<PullRequestReview> => {
      runs += 1
      return review()
    }
    const first = flight.start(run)
    const second = flight.start(run)
    expect(first).toBe(second)
    expect(await first).toBe(await second)
    expect(runs).toBe(1)
  })

  test('drops every subscriber once it settles', async () => {
    const flight = new PullRequestReviewFlight()
    const received: PullRequestReviewProgress[] = []
    flight.join((progress) => received.push(progress))
    const captured = emitter()
    await flight.start(async (send) => {
      captured.send = send
      send(metadata())
      return review()
    })
    flight.settle()
    captured.send?.(page('a'))

    expect(kinds(received)).toEqual(['metadata'])
    // The record survives so a replay is still correct after the flight ends.
    expect(kinds(flight.replay())).toEqual(['metadata', 'files'])
  })

  test('throws when the promise is read before the fetch starts', () => {
    const flight = new PullRequestReviewFlight()
    expect(() => flight.promise).toThrow('This pull request flight has not started.')
  })

  test('aborts only when the last caller that claimed it cancels', () => {
    const flight = new PullRequestReviewFlight()
    flight.attach('tab-a')
    flight.attach('tab-b')

    flight.detach('tab-a')
    expect(flight.abort.signal.aborted).toBe(false)
    // An id that never claimed the flight — a warmup — cannot end it either.
    flight.detach('warmup')
    expect(flight.abort.signal.aborted).toBe(false)

    flight.detach('tab-b')
    expect(flight.abort.signal.aborted).toBe(true)
  })

  test('leaves an unclaimed warmup fetch running', () => {
    const flight = new PullRequestReviewFlight()
    flight.detach('warmup')
    expect(flight.abort.signal.aborted).toBe(false)
  })

  test('reports a foreground reader once one attaches', () => {
    const flight = new PullRequestReviewFlight()
    expect(flight.foregroundAttached).toBe(false)

    flight.attach('tab-a')
    expect(flight.foregroundAttached).toBe(true)

    flight.attach('tab-b')
    flight.detach('tab-a')
    expect(flight.foregroundAttached).toBe(true)
    flight.detach('tab-b')
    expect(flight.foregroundAttached).toBe(false)
  })
})

describe('ReviewFlight', () => {
  test('replays already-emitted pages to a late joiner', async () => {
    const flight = new ReviewFlight<string, string>()
    const first: string[] = []
    const run = flight.start(async (emit) => {
      emit('a')
      emit('b')
      return 'done'
    })
    flight.join((page) => first.push(page))
    const second: string[] = []
    const joined = flight.join((page) => second.push(page))
    expect(await run).toBe('done')
    expect(await joined).toBe('done')
    expect(first).toEqual(['a', 'b'])
    expect(second).toEqual(['a', 'b'])
  })

  test('throws when join is called before start', () => {
    const flight = new ReviewFlight<string, string>()
    expect(() => flight.join()).toThrow('This review flight has not started.')
  })
})
