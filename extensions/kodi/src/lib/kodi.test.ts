import { describe, expect, test } from 'bun:test'

import { kodiLaunchPlan } from './kodi'

const deepLink = 'kodi://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F717&intent=open'

describe('kodiLaunchPlan', () => {
  test('reaches a running Kodi through the scheme instead of relaunching it', () => {
    expect(kodiLaunchPlan({ deepLink, intent: 'open', running: true }))
      .toEqual({ kind: 'scheme', args: [deepLink] })
  })

  test('warms a running Kodi in the background', () => {
    expect(kodiLaunchPlan({ deepLink, intent: 'warmup', running: true }))
      .toEqual({ kind: 'scheme', args: ['-g', deepLink] })
  })

  test('never starts Kodi to warm it', () => {
    expect(kodiLaunchPlan({ deepLink, intent: 'warmup', running: false })).toEqual({ kind: 'none' })
  })

  test('launches a cold Kodi with the URL on the command line', () => {
    expect(kodiLaunchPlan({ deepLink, intent: 'open', running: false })).toEqual({
      kind: 'launch',
      args: ['-a', 'Kodi', '--args', `--kodi-url=${deepLink}`]
    })
  })
})
