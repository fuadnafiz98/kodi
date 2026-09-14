import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type {
  AgentAskInput,
  AgentProvider,
  AgentRequestSubject,
  AgentProviderStatuses,
  RepositoryApi
} from '../../../shared/contracts'
import type { AgentSelection } from './agentAttachments'
import { useAgentSession } from './useAgentSession'

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete window.repository
})

const statuses: AgentProviderStatuses = {
  claude: {
    provider: 'claude', installed: true, authenticated: true,
    label: 'Connected', detail: 'Claude Code is connected.'
  },
  codex: {
    provider: 'codex', installed: true, authenticated: true,
    label: 'Connected', detail: 'Codex is connected.'
  }
}

function subject(name: string, number: number): AgentRequestSubject {
  return {
    tabId: `patch:${name}:${number}`,
    repositoryRoot: `/${name}`,
    repositoryName: name,
    source: 'patch',
    baseOid: `base-${number}`,
    headOid: `head-${number}`
  }
}

function selection(path: string, selectedText: string): AgentSelection {
  return {
    path,
    startLine: 4,
    endLine: 5,
    side: 'additions',
    selectedText,
    blobOid: 'blob-new'
  }
}

test('keeps attachments per tab and sends each request to that tab repository', async () => {
  const requests: AgentAskInput[] = []
  const askAgent = mock(async (request: AgentAskInput) => { requests.push(request) })
  window.repository = {
    askAgent,
    cancelAgent: async () => {},
    onAgentEvent: () => () => {},
    getAgentModels: async () => ({
      claude: [{ id: 'sonnet', label: 'Sonnet', description: '', efforts: ['high'], defaultEffort: 'high' }],
      codex: [{ id: 'default', label: 'Default', description: '', efforts: ['high'], defaultEffort: 'high' }]
    }),
    getAgentStatuses: async () => statuses
  } as unknown as RepositoryApi

  const repoA = subject('repo-a', 21)
  const repoB = subject('repo-b', 42)
  const { result, rerender } = renderHook(
    ({ currentSubject }: { currentSubject: AgentRequestSubject }) => useAgentSession({
      context: `Context for ${currentSubject.repositoryName}`,
      subject: currentSubject
    }),
    { initialProps: { currentSubject: repoA } }
  )

  await act(async () => {
    result.current.attach(selection('src/a.ts', 'const repoA = true'))
    await Promise.resolve()
  })
  expect(result.current.attachments[0]?.selectedText).toBe('const repoA = true')

  rerender({ currentSubject: repoB })
  expect(result.current.attachments).toEqual([])
  await act(async () => {
    result.current.attach(selection('src/b.ts', 'const repoB = true'))
    await Promise.resolve()
  })

  rerender({ currentSubject: repoA })
  expect(result.current.attachments[0]?.path).toBe('src/a.ts')
  await act(async () => {
    result.current.ask('Explain A')
    await Promise.resolve()
  })

  rerender({ currentSubject: repoB })
  expect(result.current.attachments[0]?.path).toBe('src/b.ts')
  await act(async () => {
    result.current.ask('Explain B')
    await Promise.resolve()
  })

  expect(requests).toHaveLength(2)
  expect(requests[0]?.subject).toEqual(repoA)
  expect(requests[0]?.accessMode).toBe('review')
  expect(requests[0]?.prompt).toContain('const repoA = true')
  expect(requests[0]?.prompt).not.toContain('const repoB = true')
  expect(requests[0]?.selections).toEqual([selection('src/a.ts', 'const repoA = true')])
  expect(requests[1]?.subject).toEqual(repoB)
  expect(requests[1]?.prompt).toContain('const repoB = true')
  expect(requests[1]?.prompt).not.toContain('const repoA = true')
  expect(requests[1]?.selections).toEqual([selection('src/b.ts', 'const repoB = true')])
})

test('keeps configured write access only for a working-tree tab', async () => {
  const requests: AgentAskInput[] = []
  window.repository = {
    askAgent: async (request: AgentAskInput) => { requests.push(request) },
    cancelAgent: async () => {},
    onAgentEvent: () => () => {}
  } as unknown as RepositoryApi
  const workingTree: AgentRequestSubject = {
    tabId: 'desk:/repo-a',
    repositoryRoot: '/repo-a',
    repositoryName: 'repo-a',
    source: 'workingTree',
    baseOid: 'head-a',
    headOid: 'head-a'
  }
  const { result } = renderHook(() => useAgentSession({ context: 'Working tree', subject: workingTree }))

  expect(result.current.accessMode).toBe('auto')
  expect(result.current.accessModeLocked).toBe(false)
  await act(async () => {
    result.current.ask('Inspect the working tree')
    await Promise.resolve()
  })

  expect(requests[0]?.subject.repositoryRoot).toBe('/repo-a')
  expect(requests[0]?.accessMode).toBe('auto')
  expect(requests[0]?.selections).toEqual([])
})

test('keeps the ask callback stable across an unrelated parent render', () => {
  const currentSubject = subject('repo-a', 21)
  const { result, rerender } = renderHook(() => useAgentSession({
    context: 'Review context',
    subject: currentSubject
  }))
  const firstAsk = result.current.ask

  rerender()

  expect(result.current.ask).toBe(firstAsk)
})

test('does not repeat the global status probe when sign-in starts', async () => {
  const probes: Array<'claude' | 'codex' | undefined> = []
  const disconnected: AgentProviderStatuses = {
    claude: { ...statuses.claude, authenticated: false },
    codex: { ...statuses.codex, authenticated: false }
  }
  window.repository = {
    askAgent: async () => {},
    cancelAgent: async () => {},
    onAgentEvent: () => () => {},
    loginAgent: async () => {},
    getAgentModels: async () => ({
      claude: [{ id: 'sonnet', label: 'Sonnet', description: '', efforts: ['high'], defaultEffort: 'high' }],
      codex: [{ id: 'default', label: 'Default', description: '', efforts: ['high'], defaultEffort: 'high' }]
    }),
    getAgentStatuses: async (provider?: AgentProvider) => {
      probes.push(provider)
      return disconnected
    }
  } as unknown as RepositoryApi

  const { result } = renderHook(() => useAgentSession({
    context: 'Review context',
    subject: subject('repo-a', 21)
  }))

  act(() => result.current.toggle())
  await waitFor(() => expect(probes).toEqual([undefined]))
  probes.length = 0

  act(() => result.current.login('codex'))
  await new Promise((resolve) => window.setTimeout(resolve, 50))
  expect(probes).toEqual([])
  await waitFor(() => expect(probes).toEqual(['codex']), { timeout: 2_500 })
})
