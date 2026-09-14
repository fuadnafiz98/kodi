import { describe, expect, test } from 'bun:test'

import { getAvatarDataUrl, loadAvatarImage, MAX_AVATAR_BYTES } from './avatars.js'

const pngResponse = (bytes: Uint8Array, contentType = 'image/png'): Promise<Response> =>
  Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': contentType } }))

describe('loadAvatarImage', () => {
  test('rejects hosts outside GitHub', async () => {
    await expect(loadAvatarImage('https://example.com/a.png', async () => pngResponse(new Uint8Array([1]))))
      .resolves.toBeNull()
  })

  test('rejects non-https URLs', async () => {
    await expect(loadAvatarImage('http://avatars.githubusercontent.com/u/1')).resolves.toBeNull()
  })

  test('answers null for a missing or non-image response', async () => {
    await expect(loadAvatarImage('https://avatars.githubusercontent.com/u/1', async () =>
      new Response('nope', { status: 404 }))).resolves.toBeNull()
    await expect(loadAvatarImage('https://avatars.githubusercontent.com/u/2', async () =>
      new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }))).resolves.toBeNull()
  })

  test('rejects an oversized image', async () => {
    await expect(loadAvatarImage('https://avatars.githubusercontent.com/u/3', async () =>
      pngResponse(new Uint8Array(MAX_AVATAR_BYTES + 1)))).resolves.toBeNull()
  })

  test('encodes a small image as a data URL', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    await expect(loadAvatarImage('https://avatars.githubusercontent.com/u/4', async () => pngResponse(bytes)))
      .resolves.toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
  })

  test('answers null instead of throwing when the fetch fails', async () => {
    await expect(loadAvatarImage('https://avatars.githubusercontent.com/u/5', async () => {
      throw new Error('offline')
    })).resolves.toBeNull()
  })
})

describe('getAvatarDataUrl', () => {
  test('fetches each URL once per session', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return pngResponse(new Uint8Array([1]))
    }
    const url = 'https://avatars.githubusercontent.com/u/cache-test'
    await getAvatarDataUrl(url, fetchImpl)
    await getAvatarDataUrl(url, fetchImpl)
    expect(calls).toBe(1)
  })
})
