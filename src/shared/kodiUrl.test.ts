import { describe, expect, it } from 'bun:test'

import { findKodiFolderRequest, findKodiReviewRequest, formatKodiReviewUrl, parseKodiReviewUrl } from './kodiUrl.js'

const pullRequestUrl = 'https://github.com/acme/app/pull/9'

describe('formatKodiReviewUrl', () => {
  it('omits the default open intent', () => {
    expect(formatKodiReviewUrl(pullRequestUrl)).toBe(
      'kodi://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9'
    )
  })

  it('marks a warmup so the app can fetch without focusing', () => {
    expect(formatKodiReviewUrl(`${pullRequestUrl}/files`, 'warmup')).toBe(
      'kodi://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9&intent=warmup'
    )
  })

  it('rejects values that are not pull requests', () => {
    expect(formatKodiReviewUrl('https://github.com/acme/app/issues/9')).toBeNull()
  })
})

describe('parseKodiReviewUrl', () => {
  it('round-trips an open and a warmup link', () => {
    expect(parseKodiReviewUrl(formatKodiReviewUrl(pullRequestUrl) ?? '')).toEqual({
      url: pullRequestUrl,
      intent: 'open'
    })
    expect(parseKodiReviewUrl(formatKodiReviewUrl(pullRequestUrl, 'warmup') ?? '')).toEqual({
      url: pullRequestUrl,
      intent: 'warmup'
    })
  })

  it('accepts a bare GitHub pull-request URL', () => {
    expect(parseKodiReviewUrl(`${pullRequestUrl}/files?diff=split`)).toEqual({
      url: pullRequestUrl,
      intent: 'open'
    })
  })

  it('rejects unknown intents and non-review hosts', () => {
    expect(parseKodiReviewUrl('kodi://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9&intent=delete'))
      .toBeNull()
    expect(parseKodiReviewUrl('kodi://settings?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9'))
      .toBeNull()
    expect(parseKodiReviewUrl('kodi://review?url=https%3A%2F%2Fevil.example%2Fpull%2F9')).toBeNull()
  })

  it('still opens horus:// links written before the rename', () => {
    expect(parseKodiReviewUrl('horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9'))
      .toEqual({ url: pullRequestUrl, intent: 'open' })
    expect(parseKodiReviewUrl('horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9&intent=warmup'))
      .toEqual({ url: pullRequestUrl, intent: 'warmup' })
  })
})

describe('findKodiReviewRequest', () => {
  it('prefers --kodi-url over other arguments', () => {
    expect(findKodiReviewRequest([
      '/Applications/Electron.app/Contents/MacOS/Electron',
      'out/main/index.js',
      'https://github.com/other/repo/pull/1',
      '--kodi-url',
      formatKodiReviewUrl(pullRequestUrl, 'warmup') ?? ''
    ])).toEqual({ url: pullRequestUrl, intent: 'warmup' })
  })

  it('reads an equals-form flag and a kodi:// argument', () => {
    expect(findKodiReviewRequest([
      `--kodi-url=${formatKodiReviewUrl(pullRequestUrl) ?? ''}`
    ])).toEqual({ url: pullRequestUrl, intent: 'open' })
    expect(findKodiReviewRequest([
      formatKodiReviewUrl(pullRequestUrl, 'warmup') ?? ''
    ])).toEqual({ url: pullRequestUrl, intent: 'warmup' })
  })

  it('accepts a GitHub URL dropped onto the app', () => {
    expect(findKodiReviewRequest([
      '/Applications/Kodi.app/Contents/MacOS/Kodi',
      `${pullRequestUrl}/files`
    ])).toEqual({ url: pullRequestUrl, intent: 'open' })
  })

  it('ignores electron helper flags', () => {
    expect(findKodiReviewRequest([
      'Electron',
      '--inspect=9229',
      '--remote-debugging-port=9222'
    ])).toBeNull()
  })

  it('reads the legacy --horus-url flag and horus:// argument', () => {
    expect(findKodiReviewRequest([
      'Kodi',
      '--horus-url',
      'horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9&intent=warmup'
    ])).toEqual({ url: pullRequestUrl, intent: 'warmup' })
    expect(findKodiReviewRequest([
      'horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9'
    ])).toEqual({ url: pullRequestUrl, intent: 'open' })
  })
})

describe('findKodiFolderRequest', () => {
  it('reads --kodi-folder in both flag forms', () => {
    expect(findKodiFolderRequest(['Kodi', '--kodi-folder', '/repo/app'])).toBe('/repo/app')
    expect(findKodiFolderRequest(['Kodi', '--kodi-folder=/repo/app'])).toBe('/repo/app')
  })

  it('takes the last bare positional argument when allowed', () => {
    expect(findKodiFolderRequest([
      '/Applications/Kodi.app/Contents/MacOS/Kodi',
      '.'
    ], true)).toBe('.')
    expect(findKodiFolderRequest([
      '/Applications/Kodi.app/Contents/MacOS/Kodi',
      './src',
      '/repo/other'
    ], true)).toBe('/repo/other')
  })

  it('ignores positional arguments unless allowed', () => {
    expect(findKodiFolderRequest(['Electron', '.'])).toBeNull()
  })

  it('never treats URLs, flags, or flag values as folders', () => {
    expect(findKodiFolderRequest([
      'Kodi',
      'kodi://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9',
      'https://github.com/acme/app/pull/9',
      '--remote-debugging-port=9222',
      '--kodi-url',
      '/tmp/not-a-folder',
      '-psn_0_12345'
    ], true)).toBeNull()
  })

  it('prefers the explicit flag over a positional argument', () => {
    expect(findKodiFolderRequest([
      'Kodi',
      '/positional/repo',
      '--kodi-folder',
      '/flagged/repo'
    ], true)).toBe('/flagged/repo')
  })

  it('survives Chromium reordering a second-instance argv switch-first', () => {
    // The running instance receives switches before positionals, so a
    // space-form flag value can be an injected switch — the real path lands in
    // the positional pass instead.
    expect(findKodiFolderRequest([
      'Kodi',
      '--kodi-folder',
      '--allow-file-access-from-files',
      '--enable-avfoundation',
      'out/main/index.js',
      '/tmp/real-folder'
    ], true)).toBe('/tmp/real-folder')
    expect(findKodiFolderRequest([
      'Kodi',
      '--kodi-folder=/tmp/real-folder',
      '-psn_0_12345'
    ], true)).toBe('/tmp/real-folder')
  })
})
