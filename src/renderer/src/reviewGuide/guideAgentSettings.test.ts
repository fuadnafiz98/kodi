import { beforeEach, describe, expect, test } from 'bun:test'

import { guideAgentChoice, resolveGuideRun, setGuideAgentChoice } from './guideAgentSettings'

const dock = { provider: 'claude' as const, model: 'claude-opus-5-5', effort: 'high' }

describe('guide agent choice', () => {
  beforeEach(() => setGuideAgentChoice({ provider: null, model: '', effort: '', instructions: '' }))

  test('follows the agent dock until a provider is picked', () => {
    expect(resolveGuideRun(guideAgentChoice(), dock)).toEqual(dock)
  })

  test('a picked provider, model and effort replace the dock’s', () => {
    setGuideAgentChoice({ provider: 'codex', model: 'gpt-5', effort: 'medium' })
    expect(resolveGuideRun(guideAgentChoice(), dock)).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'medium' })
  })

  test('instructions travel as the run’s custom prompt, blank ones do not', () => {
    setGuideAgentChoice({ instructions: '  start with the API  ' })
    expect(resolveGuideRun(guideAgentChoice(), dock).customPrompt).toBe('start with the API')
    setGuideAgentChoice({ instructions: '   ' })
    expect('customPrompt' in resolveGuideRun(guideAgentChoice(), dock)).toBe(false)
  })

  test('the choice is kept across windows', () => {
    setGuideAgentChoice({ provider: 'codex', model: 'gpt-5', effort: 'low' })
    expect(JSON.parse(localStorage.getItem('kodi:guide-agent:v1') ?? '{}')).toMatchObject({ provider: 'codex', model: 'gpt-5', effort: 'low' })
  })
})
