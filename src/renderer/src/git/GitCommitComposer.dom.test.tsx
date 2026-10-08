import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { GitCommitComposer, type GitCommitComposerProps } from './GitCommitComposer'

afterEach(() => {
  cleanup()
  delete (window as { repository?: unknown }).repository
  delete window.__kodiReviewGuide
})

function props(overrides: Partial<GitCommitComposerProps> = {}): GitCommitComposerProps {
  return {
    root: `/repo-${Math.random()}`,
    branch: 'main',
    stagedCount: 1,
    changeCount: 1,
    lastCommitSubject: null,
    committing: false,
    blocked: false,
    onCommit: async () => true,
    ...overrides
  }
}

function withAgent(): void {
  window.__kodiReviewGuide = { agent: { provider: 'claude', model: 'opus', effort: 'low' } } as unknown as NonNullable<Window['__kodiReviewGuide']>
}

test('the suggestion fills the message with its title and body, read-only while it runs', async () => {
  let answer!: (value: { title: string; body: string }) => void
  const suggestCommitMessage = mock(() => new Promise<{ title: string; body: string }>((resolve) => { answer = resolve }))
  ;(window as { repository?: unknown }).repository = { suggestCommitMessage, cancelCommitMessage: mock(async () => {}) }
  withAgent()
  render(<GitCommitComposer {...props()} />)

  const field = screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement
  fireEvent.click(screen.getByRole('button', { name: 'Suggest a commit message from the staged changes' }))
  expect(suggestCommitMessage).toHaveBeenCalledWith({ provider: 'claude', model: 'opus', effort: 'low' })
  expect(field.readOnly).toBe(true)
  await act(async () => { answer({ title: 'Add the guide', body: 'Orders the review.' }) })
  expect(field.value).toBe('Add the guide\n\nOrders the review.')
  expect(field.readOnly).toBe(false)
})

test('a second press while it runs cancels, and a cancel shows no error', async () => {
  let fail!: (error: Error) => void
  const cancelCommitMessage = mock(async () => { fail(new Error("Error invoking remote method 'x': Error: The run was cancelled.")) })
  ;(window as { repository?: unknown }).repository = {
    suggestCommitMessage: () => new Promise((_resolve, reject) => { fail = reject }),
    cancelCommitMessage
  }
  withAgent()
  render(<GitCommitComposer {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Suggest a commit message from the staged changes' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop writing the commit message' })) })
  expect(cancelCommitMessage).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a failure is shown under the field, without the IPC wrapper', async () => {
  ;(window as { repository?: unknown }).repository = {
    suggestCommitMessage: async () => { throw new Error("Error invoking remote method 'repository:suggest-commit-message': Error: Not signed in.") },
    cancelCommitMessage: async () => {}
  }
  withAgent()
  render(<GitCommitComposer {...props()} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Suggest a commit message from the staged changes' })) })
  expect(screen.getByRole('alert').textContent).toBe('Not signed in.')
})

test('nothing staged: the button is off', () => {
  render(<GitCommitComposer {...props({ stagedCount: 0 })} />)
  expect((screen.getByRole('button', { name: 'Suggest a commit message from the staged changes' }) as HTMLButtonElement).disabled).toBe(true)
})
