import { describe, expect, test } from 'bun:test'

import {
  GITHUB_TOKEN_TTL_MS,
  loadMarkdownMedia,
  MAX_MARKDOWN_MEDIA_BYTES,
  readGitHubAuthToken,
  resetGitHubAuthTokenForTests
} from './markdownMedia.js'

describe('loadMarkdownMedia', () => {
  test('rejects hosts outside GitHub', async () => {
    await expect(loadMarkdownMedia('https://example.com/clip.webm', fetch, async () => null))
      .rejects.toThrow('Only GitHub-hosted videos can be previewed.')
  })

  test('returns the downloaded bytes and a video mime type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = async (): Promise<Response> => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'video/webm' }
    })

    await expect(loadMarkdownMedia(
      'https://github.com/user-attachments/assets/clip.webm',
      fetchImpl,
      async () => 'token'
    )).resolves.toEqual({ mimeType: 'video/webm', bytes })
  })

  test('falls back to the extension when GitHub omits a useful content type', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(new Uint8Array([9]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })

    const media = await loadMarkdownMedia(
      'https://github.com/user-attachments/assets/demo.mp4',
      fetchImpl,
      async () => null
    )
    expect(media.mimeType).toBe('video/mp4')
  })

  test('rejects an oversized download', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(
      new Uint8Array(MAX_MARKDOWN_MEDIA_BYTES + 1),
      {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      }
    )

    await expect(loadMarkdownMedia(
      'https://github.com/user-attachments/assets/huge.mp4',
      fetchImpl,
      async () => null
    )).rejects.toThrow('too large')
  })
})

describe('readGitHubAuthToken', () => {
  test('asks gh once per ten minutes and forgets a miss', async () => {
    resetGitHubAuthTokenForTests()
    let spawns = 0
    let answer: string | null = null
    const spawn = async (): Promise<string | null> => {
      spawns += 1
      return answer
    }
    try {
      expect(await readGitHubAuthToken(spawn, 0)).toBeNull()
      // Signed in since: the miss was not remembered.
      answer = 'token-1'
      expect(await readGitHubAuthToken(spawn, 1)).toBe('token-1')
      expect(await readGitHubAuthToken(spawn, 2)).toBe('token-1')
      expect(await readGitHubAuthToken(spawn, GITHUB_TOKEN_TTL_MS)).toBe('token-1')
      expect(spawns).toBe(2)

      answer = 'token-2'
      expect(await readGitHubAuthToken(spawn, GITHUB_TOKEN_TTL_MS + 2)).toBe('token-2')
      expect(spawns).toBe(3)
    } finally {
      resetGitHubAuthTokenForTests()
    }
  })

  test('shares one spawn between concurrent loads and drops a failed one', async () => {
    resetGitHubAuthTokenForTests()
    let spawns = 0
    const failing = async (): Promise<string | null> => {
      spawns += 1
      throw new Error('gh is missing')
    }
    try {
      const [left, right] = await Promise.all([readGitHubAuthToken(failing, 0), readGitHubAuthToken(failing, 0)])
      expect([left, right, spawns]).toEqual([null, null, 1])
      await readGitHubAuthToken(failing, 1)
      expect(spawns).toBe(2)
    } finally {
      resetGitHubAuthTokenForTests()
    }
  })
})
