import { afterEach, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import type { RepositorySnapshot } from '../../../shared/contracts'
import { Titlebar } from './Titlebar'
import { DEFAULT_KEYBINDINGS } from '../settings/keybindings'

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

test('Titlebar keeps explorer controls out of the window chrome', () => {
  render(<Titlebar snapshot={snapshot} keybindings={DEFAULT_KEYBINDINGS} newTab={false}
    locator="" locatorBusy={false} onLocatorChange={() => {}} onLocatorSubmit={() => {}}
    onSearchOpen={() => {}}
    onSettingsOpen={() => {}} onGitOpen={() => {}} agentOpen={false} onAgentToggle={() => {}}
    terminalOpen={false} onTerminalToggle={() => {}} />)

  expect(screen.queryByRole('button', { name: 'Hide explorer' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Switch branch/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open branches and pull requests' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Search files and commands' }).getAttribute('title')).toContain('⌘P')
  expect(screen.queryByRole('combobox')).toBeNull()
})

test('Titlebar centers the pull-request locator on a new tab', () => {
  render(<Titlebar snapshot={null} keybindings={DEFAULT_KEYBINDINGS} newTab={true}
    locator="" locatorBusy={false} onLocatorChange={() => {}} onLocatorSubmit={() => {}}
    onSearchOpen={() => {}}
    onSettingsOpen={() => {}} onGitOpen={() => {}} agentOpen={false} onAgentToggle={() => {}}
    terminalOpen={false} onTerminalToggle={() => {}} />)

  expect(screen.getByRole('textbox', { name: 'Open pull request URL' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Choose project folder' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Search files and commands' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open branches and pull requests' })).toBeNull()
})

test('Titlebar names the chosen review folder on a new tab', () => {
  render(<Titlebar snapshot={null} keybindings={DEFAULT_KEYBINDINGS} newTab={true}
    locator="https://github.com/acme/app/pull/9" locatorBusy={false}
    reviewFolderName="app" reviewFolderPath="~/Developer/app"
    onLocatorChange={() => {}} onLocatorSubmit={() => {}}
    onSearchOpen={() => {}}
    onSettingsOpen={() => {}} onGitOpen={() => {}} agentOpen={false} onAgentToggle={() => {}}
    terminalOpen={false} onTerminalToggle={() => {}} />)

  expect(screen.getByRole('button', { name: 'Review in app' }).getAttribute('title'))
    .toBe('~/Developer/app')
})
