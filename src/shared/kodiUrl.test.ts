import { describe, expect, it } from 'bun:test'

import {
  findKodiClaudeSessionRequest,
  findKodiFolderRequest,
  findKodiGuideFileRequest,
  findKodiRefRequest,
  findKodiReviewRequest,
  formatKodiReviewUrl,
  parseKodiReviewUrl
} from './kodiUrl.js'

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

describe('findKodiRefRequest', () => {
  it('reads a full SHA in both flag forms', () => {
    expect(findKodiRefRequest(['Kodi', '--kodi-ref=0123456789abcdef0123456789abcdef01234567'])).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(findKodiRefRequest(['Kodi', '--kodi-ref', '0123456789ABCDEF0123456789ABCDEF01234567'])).toBe('0123456789abcdef0123456789abcdef01234567')
  })

  it('survives a switch-first argv', () => {
    expect(findKodiRefRequest(['Kodi', '--kodi-folder=/repo', '--kodi-ref=0123456789abcdef0123456789abcdef01234567', '--allow-file-access', '/repo'])).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(findKodiRefRequest(['Kodi', '--kodi-ref', '--allow-file-access', '/repo'])).toBeNull()
  })

  it('rejects anything but a 40-hex commit', () => {
    expect(findKodiRefRequest(['Kodi', '--kodi-ref=main'])).toBeNull()
    expect(findKodiRefRequest(['Kodi', '--kodi-ref=0123abc'])).toBeNull()
    expect(findKodiRefRequest(['Kodi'])).toBeNull()
  })
})

describe('findKodiGuideFileRequest', () => {
  it('reads an absolute path, spaces included', () => {
    expect(findKodiGuideFileRequest(['Kodi', '--kodi-guide-file=/tmp/my guides/g.json'])).toBe('/tmp/my guides/g.json')
    expect(findKodiGuideFileRequest(['Kodi', '--kodi-folder=/repo', '--kodi-guide-file', '/tmp/g.json'])).toBe('/tmp/g.json')
  })

  it('rejects a relative path', () => {
    expect(findKodiGuideFileRequest(['Kodi', '--kodi-guide-file=g.json'])).toBeNull()
    expect(findKodiGuideFileRequest(['Kodi', '--kodi-guide-file', '--no-sandbox'])).toBeNull()
  })

  it('never reads a guide or ref value as the folder', () => {
    expect(findKodiFolderRequest(['Kodi', '--kodi-guide-file', '/tmp/g.json', '/repo'], true)).toBe('/repo')
    expect(findKodiFolderRequest(['Kodi', '--kodi-ref', '0123456789abcdef0123456789abcdef01234567'], true)).toBeNull()
  })
})

describe('findKodiClaudeSessionRequest', () => {
  it('reads a session uuid and rejects anything else', () => {
    expect(findKodiClaudeSessionRequest(['Kodi', '--kodi-claude-session=1B4E28BA-2FA1-11D2-883F-0016D3CCA427']))
      .toBe('1b4e28ba-2fa1-11d2-883f-0016d3cca427')
    expect(findKodiClaudeSessionRequest(['Kodi', '--kodi-claude-session=../../etc/passwd'])).toBeNull()
  })
})
