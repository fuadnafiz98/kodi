import { afterEach, expect, test } from 'bun:test'

import type { RepositoryApi } from '../../../shared/contracts'
import { loadRemoteAvatar, MAX_REMOTE_AVATARS } from './RemoteAvatar'

afterEach(() => {
  delete window.repository
})

test('keeps the most recently used avatars and forgets the rest', async () => {
  const requested: string[] = []
  window.repository = {
    getAvatar: (url: string) => {
      requested.push(url)
      return Promise.resolve(`data:${url}`)
    }
  } as unknown as RepositoryApi
  const url = (index: number): string => `https://avatars.example/cap-${index}`

  for (let index = 0; index < MAX_REMOTE_AVATARS; index += 1) await loadRemoteAvatar(url(index))
  // Touching the first one makes the second the least recently used.
  expect(await loadRemoteAvatar(url(0))).toBe(`data:${url(0)}`)
  await loadRemoteAvatar(url(MAX_REMOTE_AVATARS))
  expect(requested).toHaveLength(MAX_REMOTE_AVATARS + 1)

  await loadRemoteAvatar(url(0))
  expect(requested).toHaveLength(MAX_REMOTE_AVATARS + 1)
  await loadRemoteAvatar(url(1))
  expect(requested.at(-1)).toBe(url(1))
  expect(requested).toHaveLength(MAX_REMOTE_AVATARS + 2)
})
