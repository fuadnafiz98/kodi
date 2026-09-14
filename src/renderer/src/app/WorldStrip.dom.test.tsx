import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { PullRequestReview, RepositorySnapshot } from '../../../shared/contracts'
import { WorldStrip } from './WorldStrip'
import { createNewWorld, createPatchWorld, type DeskWorld, type ReviewWorld } from '../review/useReviewWorlds'

afterEach(cleanup)

const snapshot: RepositorySnapshot = {
  root: '/projects/alpha',
  name: 'alpha',
  kind: 'git',
  branch: 'main',
  head: 'a'.repeat(40),
  paths: ['src/app.ts'],
  statuses: [{ path: 'src/app.ts', status: 'modified' }]
}

const desk: DeskWorld = {
  source: 'desk',
  worldId: 'desk:/projects/alpha',
  label: 'alpha',
  root: snapshot.root,
  snapshot,
  baselineOid: snapshot.head,
  workingRevision: 0
}

function review(number: number, repository = 'acme/alpha'): PullRequestReview {
  return {
    kind: 'github',
    selector: String(number),
    baseOid: `base-${number}`,
    headOid: `head-${number}`,
    commitId: `head-${number}`,
    viewerCanSubmitDecision: true,
    pullRequest: {
      number,
      title: `Review ${number}`,
      url: `https://github.com/${repository}/pull/${number}`,
      state: 'OPEN',
      isDraft: false,
      author: { login: 'reviewer' },
      headRefName: `feature-${number}`,
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-29T00:00:00Z',
      additions: 2,
      deletions: 1,
      changedFiles: 1
    },
    files: [{ path: 'src/app.ts', additions: 2, deletions: 1 }],
    patch: '',
    omittedFiles: [],
    expectedFileCount: 1
  }
}

test('renders browser-style tab controls and routes focus, close, and new actions', () => {
  const patch = createPatchWorld(snapshot, review(221), 1, 'ready')
  const focused: string[] = []
  const closed: string[] = []
  let created = 0

  render(<WorldStrip worlds={[desk, patch]} activeWorldId={patch.worldId} collisionCount={2}
    onFocus={(worldId) => { focused.push(worldId) }}
    onClose={(worldId) => { closed.push(worldId) }}
    onNew={() => { created += 1 }} />)

  expect(screen.getByRole('navigation', { name: 'Review tabs' })).toBeTruthy()
  expect(screen.queryByText('Review')).toBeNull()
  expect(screen.queryByText('⌘⇧[ ]')).toBeNull()
  expect(screen.getByRole('tab', { name: 'alpha' }).getAttribute('aria-selected')).toBe('false')
  expect(screen.getByRole('tab', { name: /#221 · acme\/alpha/ }).getAttribute('aria-selected')).toBe('true')

  fireEvent.click(screen.getByRole('tab', { name: 'alpha' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close alpha tab' }))
  fireEvent.click(screen.getByRole('button', { name: 'New tab' }))

  expect(focused).toEqual([desk.worldId])
  expect(closed).toEqual([desk.worldId])
  expect(created).toBe(1)
})

test('keeps an active overflow tab visible and makes the remaining tabs searchable', () => {
  const worlds: ReviewWorld[] = [createNewWorld(), desk]
  for (let number = 1; number <= 8; number += 1) {
    worlds.push(createPatchWorld(snapshot, review(number, `acme/repo-${number}`), number, 'ready'))
  }
  const active = worlds.at(-1)
  if (active == null) throw new Error('Expected an active tab fixture.')

  render(<WorldStrip worlds={worlds} activeWorldId={active.worldId} collisionCount={0}
    onFocus={() => {}} onClose={() => {}} onNew={() => {}} />)

  expect(screen.getByRole('tab', { name: /#8 · acme\/repo-8/ })).toBeTruthy()
  fireEvent.click(screen.getByLabelText(/more tabs/))
  fireEvent.change(screen.getByPlaceholderText('Search tabs'), { target: { value: 'repo-7' } })
  expect(screen.getByRole('menuitem', { name: /#7 · acme\/repo-7/ })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: /#6 · acme\/repo-6/ })).toBeNull()
})

test('closes the overflow menu after choosing a tab', () => {
  const worlds: ReviewWorld[] = [createNewWorld(), desk]
  for (let number = 1; number <= 8; number += 1) {
    worlds.push(createPatchWorld(snapshot, review(number, `acme/repo-${number}`), number, 'ready'))
  }
  const focused: string[] = []
  render(<WorldStrip worlds={worlds} activeWorldId={desk.worldId} collisionCount={0}
    onFocus={(worldId) => { focused.push(worldId) }} onClose={() => {}} onNew={() => {}} />)

  const details = screen.getByLabelText(/more tabs/).closest('details')
  expect(details).toBeTruthy()
  fireEvent.click(screen.getByLabelText(/more tabs/))
  expect(details?.open).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: /#7 · acme\/repo-7/ }))
  expect(focused.at(-1)).toContain('repo-7')
  expect(details?.open).toBe(false)
})

test('arrow keys move focus along the tablist', () => {
  const focused: string[] = []
  const patch = createPatchWorld(snapshot, review(221), 1, 'ready')
  render(<WorldStrip worlds={[desk, patch]} activeWorldId={desk.worldId} collisionCount={0}
    onFocus={(worldId) => { focused.push(worldId) }} onClose={() => {}} onNew={() => {}} />)

  fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
  expect(focused).toEqual([patch.worldId])
})
