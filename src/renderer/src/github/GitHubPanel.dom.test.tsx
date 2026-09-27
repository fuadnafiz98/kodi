import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import type { RepositoryPanelTab } from '../git/useGitWorkflow'
import { RepositoryPanel } from './GitHubPanel'

afterEach(cleanup)

const noop = (): void => {}
const resolved = async (): Promise<boolean> => true

// The workflow owns `panelTab`: tab clicks inside the panel write it back, and
// the titlebar's Source Control and the palette's branch switcher set it.
let requestTab: (tab: RepositoryPanelTab) => void = noop

function Host({ open = true }: { open?: boolean }): React.JSX.Element {
  const [panelTab, setPanelTab] = useState<RepositoryPanelTab>('changes')
  requestTab = setPanelTab
  return (
    <RepositoryPanel open={open} initialTab={panelTab} root="/repo" repositoryName="repo" branch="main"
      statuses={[]} onTabChange={setPanelTab} onConfirmStage={resolved} onStage={resolved}
      onUnstage={resolved} onDiscard={resolved} onCommit={resolved} onOpenChangedFile={noop}
      integration={null} loading={false} inbox={null} loadingInbox={false} actionKey={null}
      onClose={noop} onSwitchBranch={noop} onReviewLocalBranch={noop} onReviewCommit={noop}
      onFetch={noop} onPull={noop} onPush={noop} onReview={noop} onMerge={noop} onMarkReady={noop}
      onOpenPullRequest={noop} onCheckout={noop} updatedAt={null} />
  )
}

function selectedTab(): string | null {
  return document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null
}

test('a tab requested while the panel is open replaces the one in use', () => {
  render(<Host />)
  expect(selectedTab()).toBe('Changes0')

  fireEvent.click(screen.getByRole('tab', { name: /Branches/ }))
  expect(selectedTab()).toBe('Branches')

  // The titlebar's Source Control button while Branches is showing.
  act(() => requestTab('changes'))
  expect(selectedTab()).toBe('Changes0')
  expect(document.querySelector('.git-panel-content')?.getAttribute('data-tab')).toBe('changes')
})

test('reopening inside the exit transition lands on the tab asked for', () => {
  const { rerender } = render(<Host />)
  fireEvent.click(screen.getByRole('tab', { name: /History/ }))
  expect(selectedTab()).toBe('History')

  // Still mounted for its closing transition when Branches is asked for.
  rerender(<Host open={false} />)
  act(() => requestTab('branches'))
  rerender(<Host open />)
  expect(selectedTab()).toBe('Branches')
})

test('a stage still running for one repository does not show on the next one’s row', async () => {
  const statuses = [{ path: 'src/a.ts', status: 'modified' as const }]
  const never = (): Promise<boolean> => new Promise(() => {})
  const panel = (root: string): React.JSX.Element => (
    <RepositoryPanel open initialTab="changes" root={root} repositoryName={root.slice(1)} branch="main"
      statuses={statuses} onTabChange={noop} onConfirmStage={resolved} onStage={never}
      onUnstage={resolved} onDiscard={resolved} onCommit={resolved} onOpenChangedFile={noop}
      integration={null} loading={false} inbox={null} loadingInbox={false} actionKey={null}
      onClose={noop} onSwitchBranch={noop} onReviewLocalBranch={noop} onReviewCommit={noop}
      onFetch={noop} onPull={noop} onPush={noop} onReview={noop} onMerge={noop} onMarkReady={noop}
      onOpenPullRequest={noop} onCheckout={noop} updatedAt={null} />
  )
  const { rerender } = render(panel('/repo-a'))

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stage src/a.ts' })) })
  expect(screen.getByRole('button', { name: 'Unstage src/a.ts' })).toBeTruthy()

  // Repository B has its own, unstaged src/a.ts.
  rerender(panel('/repo-b'))
  expect(screen.getByRole('button', { name: 'Stage src/a.ts' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Unstage src/a.ts' })).toBeNull()
})
