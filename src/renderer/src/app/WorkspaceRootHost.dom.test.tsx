import { plugin } from 'bun'
import { afterEach, beforeAll, expect, test } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { transformAsync } from '@babel/core'
import { readFile } from 'node:fs/promises'
import { useEffect, useMemo } from 'react'

import type {
  GitIntegrationSnapshot,
  PullRequestInboxSnapshot,
  RepositoryApi,
  RepositorySnapshot
} from '../../../shared/contracts'
import type { WorkspaceLayoutProps } from './appLayoutProps'
import type { WorkspaceRootHostProps } from './WorkspaceRootHost'
import { useGitWorkflow } from '../git/useGitWorkflow'
import { markWorkspaceRender } from '../perf/workspaceRenderMetric'

// The app is built with the React Compiler and the test runner is not, and the
// compiler's memo slots are the whole question here: whether the element handed
// to the workspace keeps its identity when only panel state moved. The host is
// loaded through the compiler for this file alone.
const HOST_SOURCE = /\/app\/WorkspaceRootHost\.tsx$/
plugin({
  name: 'react-compiler-workspace-root-host',
  setup(build) {
    build.onLoad({ filter: HOST_SOURCE }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const compiled = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ['typescript', 'jsx'] },
        plugins: [['babel-plugin-react-compiler', { target: '19' }]]
      })
      return { contents: compiled?.code ?? source, loader: 'tsx' }
    })
  }
})

let WorkspaceRootHost: (props: WorkspaceRootHostProps) => React.JSX.Element

beforeAll(async () => {
  ;({ WorkspaceRootHost } = await import('./WorkspaceRootHost'))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete window.repository
  delete window.__kodiMetrics
})

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'head',
  paths: ['src/app.ts'],
  statuses: []
}

const integration: GitIntegrationSnapshot = {
  branches: [],
  remoteBranches: [],
  remotes: [],
  commits: [],
  defaultBranch: 'main',
  ahead: 0,
  behind: 0,
  pullRequests: [],
  githubAvailable: true,
  githubMessage: null
}

const inbox: PullRequestInboxSnapshot = { available: true, message: null, sections: [] }

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => { resolve = settle })
  return { promise, resolve }
}

function WorkspaceStandIn(): React.JSX.Element {
  useEffect(markWorkspaceRender)
  return <div data-testid="workspace" />
}

const noop = (): void => {}
const workflowOptions = {
  snapshot,
  selectedPath: 'src/app.ts',
  workspaceView: 'multi' as const,
  applySnapshot: noop,
  activateSnapshot: noop,
  onError: noop,
  onSelectPath: noop,
  onWorkspaceViewChange: noop,
  confirm: async () => true
}
const agent = { attach: noop } as unknown as WorkspaceRootHostProps['agent']
const collisionPaths: ReadonlySet<string> = new Set()
const shell = {
  WorkspaceRoot: WorkspaceStandIn,
  selectedPath: 'src/app.ts',
  comparison: null,
  loadingDiff: false,
  diffStyle: 'split',
  workspaceView: 'multi',
  preferences: { editorTheme: 'pierre-dark' },
  repositoryChange: null,
  sidebarVisible: true,
  setPreferences: noop,
  selectPath: noop,
  setDiffStyle: noop,
  setWorkspaceView: noop,
  onComparisonSaved: noop,
  setError: noop,
  toggleSidebar: noop
} as unknown as WorkspaceLayoutProps

let workflow: ReturnType<typeof useGitWorkflow> | null = null

// What App does: the git workflow is one field of the view object the stage
// hands the host, so every new workflow object is a new view.
function Stage(): React.JSX.Element {
  const gitWorkflow = useGitWorkflow(workflowOptions)
  useEffect(() => { workflow = gitWorkflow })
  const view = useMemo(() => ({ ...shell, gitWorkflow }), [gitWorkflow])
  return <WorkspaceRootHost view={view} snapshot={snapshot} agent={agent} collisionPaths={collisionPaths} />
}

function workspaceRenders(): number {
  return window.__kodiMetrics?.workspaceRenders ?? 0
}

test('opening, loading and closing the git panel does not re-render the workspace', async () => {
  const local = deferred<GitIntegrationSnapshot>()
  const pullRequests = deferred<Pick<GitIntegrationSnapshot, 'pullRequests' | 'githubAvailable' | 'githubMessage'>>()
  const pendingInbox = deferred<PullRequestInboxSnapshot>()
  window.repository = {
    getGitIntegration: () => local.promise,
    getRepositoryPullRequests: () => pullRequests.promise,
    getPullRequestInbox: () => pendingInbox.promise,
    activateRepository: async () => snapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  render(<Stage />)
  await waitFor(() => expect(workflow).not.toBeNull())
  const before = workspaceRenders()
  const workflowsBefore = workflow

  act(() => workflow!.openPanel())
  await waitFor(() => expect(workflow!.loadingIntegration).toBe(true))
  await act(async () => { local.resolve(integration) })
  await act(async () => { pullRequests.resolve(integration) })
  await act(async () => { pendingInbox.resolve(inbox) })
  await waitFor(() => expect(workflow!.loadingIntegration).toBe(false))
  act(() => workflow!.setPanelTab('history'))
  act(() => workflow!.setPanelOpen(false))

  // The workflow object really did change several times; the workspace did not.
  expect(workflow).not.toBe(workflowsBefore)
  expect(workspaceRenders() - before).toBe(0)
})

test('an action key flipping during a fetch does not re-render the workspace', async () => {
  const fetched = deferred<GitIntegrationSnapshot>()
  window.repository = {
    fetchRemote: () => fetched.promise,
    getGitIntegration: async () => integration,
    getRepositoryPullRequests: async () => integration,
    getPullRequestInbox: async () => inbox,
    activateRepository: async () => snapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  render(<Stage />)
  await waitFor(() => expect(workflow).not.toBeNull())
  const before = workspaceRenders()

  let fetching!: Promise<void>
  act(() => { fetching = workflow!.fetchRemote() })
  await waitFor(() => expect(workflow!.actionKey).toBe('sync:fetch'))
  await act(async () => {
    fetched.resolve(integration)
    await fetching
  })
  await waitFor(() => expect(workflow!.actionKey).toBeNull())

  expect(workspaceRenders() - before).toBe(0)
})
