import { describe, expect, it } from 'bun:test'

import { getErrorMessage } from './repositoryApi'

describe('getErrorMessage', () => {
  it('drops the IPC wrapper Electron puts on a rejected invoke', () => {
    expect(getErrorMessage(new Error(
      "Error invoking remote method 'repository:submit-pull-request-review': Error: This pull request has new commits since you opened it."
    ))).toBe('This pull request has new commits since you opened it.')
    expect(getErrorMessage(new Error("Error invoking remote method 'repository:x': TypeError: bad input")))
      .toBe('bad input')
  })

  it('leaves a plain message as it is', () => {
    expect(getErrorMessage(new Error('The repository tab is no longer open.'))).toBe('The repository tab is no longer open.')
    expect(getErrorMessage('offline')).toBe('offline')
  })
})
