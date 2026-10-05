import { beforeAll, afterEach, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { AgentAskInput, AgentStreamEvent, RepositoryApi } from '../../../shared/contracts'
import { AgentChatHistory } from './AgentChatHistory'
import { resetAgentChatsForTest } from './agentChats'
import { useAgentAnswer } from './useAgentAnswer'

import { loadAgentMarkdown } from './useAgentAnswer'

beforeAll(loadAgentMarkdown)

afterEach(() => {
  cleanup()
  resetAgentChatsForTest()
  localStorage.clear()
  delete window.repository
})

function Harness(): React.JSX.Element {
  const answer = useAgentAnswer()
  return (
    <div>
      <AgentChatHistory currentChatId={answer.chatId}
        onOpenChat={answer.openChat} onDeleteChat={answer.deleteChat} />
      <button type="button" onClick={answer.reset}>New conversation</button>
      <button type="button" onClick={() => answer.ask({
        provider: 'claude', model: 'sonnet', effort: 'high', accessMode: 'review',
        prompt: `prompt ${document.querySelectorAll('.question').length}`,
        question: (document.querySelector('#next') as HTMLInputElement).value,
        context: '', subject: {} as never, selections: [], sessionScope: 'scope'
      })}>Ask</button>
      <input id="next" defaultValue="" />
      {answer.history.map((turn) => <p key={turn.id} className="question">{turn.question}</p>)}
      {answer.question === '' ? null : <p className="question">{answer.question}</p>}
    </div>
  )
}

test('a new conversation keeps the previous one in the chat list, and opening it shows its turns', async () => {
  let emit: (event: AgentStreamEvent) => void = () => {}
  const requests: AgentAskInput[] = []
  window.repository = {
    askAgent: async (request: AgentAskInput) => { requests.push(request) },
    cancelAgent: async () => {},
    onAgentEvent: (listener: (event: AgentStreamEvent) => void) => {
      emit = listener
      return () => {}
    }
  } as unknown as RepositoryApi
  render(<Harness />)

  const ask = async (question: string, answer: string): Promise<void> => {
    fireEvent.change(document.querySelector('#next')!, { target: { value: question } })
    fireEvent.click(screen.getByText('Ask'))
    const id = requests.at(-1)!.id
    await act(async () => {
      emit({ id, kind: 'session', sessionId: 'cli-session-1' })
      emit({ id, kind: 'text', text: answer })
      emit({ id, kind: 'done' })
    })
  }
  await ask('Why does the cache miss?', 'Because the key changes.')
  await ask('And the fix?', 'Hash the path.')

  fireEvent.click(screen.getByText('New conversation'))
  expect(document.querySelectorAll('.question')).toHaveLength(0)

  const trigger = await screen.findByRole('button', { name: 'Chats' })
  fireEvent.click(trigger)
  const row = await screen.findByRole('button', { name: /^Why does the cache miss\?/ })
  expect(row.textContent).toContain('2 questions')
  fireEvent.click(row)

  await waitFor(() => expect([...document.querySelectorAll('.question')].map((node) => node.textContent))
    .toEqual(['Why does the cache miss?', 'And the fix?']))

  // The reopened chat carries on in the CLI session it ran in.
  await ask('One more?', 'Sure.')
  expect(requests.at(-1)?.resumeSessionId).toBe('cli-session-1')
})

test('Escape closes the list and arrow keys move between chats', async () => {
  let emit: (event: AgentStreamEvent) => void = () => {}
  const requests: AgentAskInput[] = []
  window.repository = {
    askAgent: async (request: AgentAskInput) => { requests.push(request) },
    cancelAgent: async () => {},
    onAgentEvent: (listener: (event: AgentStreamEvent) => void) => {
      emit = listener
      return () => {}
    }
  } as unknown as RepositoryApi
  render(<Harness />)
  for (const question of ['First chat', 'Second chat']) {
    fireEvent.change(document.querySelector('#next')!, { target: { value: question } })
    fireEvent.click(screen.getByText('Ask'))
    const id = requests.at(-1)!.id
    await act(async () => {
      emit({ id, kind: 'text', text: 'ok' })
      emit({ id, kind: 'done' })
    })
    fireEvent.click(screen.getByText('New conversation'))
  }

  fireEvent.click(await screen.findByRole('button', { name: 'Chats' }))
  const rows = await screen.findAllByRole('button', { name: /^(First|Second) chat/ })
  expect(rows).toHaveLength(2)
  await waitFor(() => expect(document.activeElement).toBe(rows[0]!))
  fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(rows[1]!)
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chats' })).toBeNull())
})
