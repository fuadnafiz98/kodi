import { describe, expect, test } from 'bun:test'

import { isGeneratedPath } from '../../shared/generatedPaths.js'
import { categorizePath } from '../../shared/reviewCategories.js'
import type { GuideFileCategory } from '../../shared/reviewGuide.js'

describe('categorizePath', () => {
  const cases: Array<[GuideFileCategory, string, string]> = [
    ['implementation', 'src/app.ts', 'src/app.test.ts'],
    ['test', 'src/app.test.ts', 'src/app.ts'],
    ['test', 'pkg/handler_test.go', 'pkg/handler.go'],
    ['test', 'tests/test_api.py', 'api/views.py'],
    ['test', 'Sources/AppTests.swift', 'Sources/App.swift'],
    ['test', 'e2e/login.e2e.ts', 'web/login.ts'],
    ['documentation', 'README.md', 'readme.ts'],
    ['documentation', 'docs/setup/index.html', 'src/doctor.ts'],
    ['documentation', 'CHANGELOG', 'src/changelog.ts'],
    ['generated', 'bun.lock', 'src/lock.ts'],
    ['generated', 'src/__snapshots__/view.ts.snap', 'src/snapshot.ts'],
    ['agent-guidance', 'AGENTS.md', 'AGENT.ts'],
    ['agent-guidance', '.claude/settings.json', 'claude/settings.json'],
    ['agent-guidance', 'skills/kodi/SKILL.md', 'skills/kodi/notes.ts'],
    ['agent-guidance', '.github/copilot-instructions.md', '.github/workflows/ci.yml'],
    ['localization', 'src/locales/en.json', 'src/local.json'],
    ['localization', 'App/en.lproj/Localizable.strings', 'App/en.swift'],
    ['assets', 'public/logo.svg', 'public/logo.ts'],
    ['assets', 'fonts/Inter.woff2', 'fonts/index.ts']
  ]

  for (const [category, positive, negative] of cases) {
    test(`${category}: ${positive} yes, ${negative} no`, () => {
      expect(categorizePath(positive)).toBe(category)
      expect(categorizePath(negative)).not.toBe(category)
    })
  }

  test('an attribute beats the heuristic', () => {
    expect(categorizePath('foo.test.ts', { category: 'implementation' })).toBe('implementation')
    expect(categorizePath('src/schema.ts', { category: 'generated' })).toBe('generated')
  })

  test('linguist-generated set or unset overrides the path', () => {
    expect(categorizePath('docs/api.md', { generated: true })).toBe('generated')
    expect(categorizePath('bun.lock', { generated: false })).toBe('implementation')
  })

  test('agent guidance is not documentation', () => {
    expect(categorizePath('CLAUDE.md')).toBe('agent-guidance')
    expect(categorizePath('packages/app/AGENTS.md')).toBe('agent-guidance')
  })
})

describe('isGeneratedPath', () => {
  test('lockfiles, snapshots, minified and protobuf output', () => {
    for (const path of ['yarn.lock', 'a/b/package-lock.json', 'go.sum', 'src/__generated__/x.ts', 'dist/app.min.js',
      'api/service.pb.go', 'build/app.js.map', 'proto/x_pb2.py', 'lib/model.g.dart']) {
      expect(isGeneratedPath(path)).toBe(true)
    }
  })

  test('ordinary sources and an import map are not', () => {
    for (const path of ['src/app.ts', 'web/app.importmap', 'src/generator.ts', 'lock.ts', 'src/map.ts', 'README.md']) {
      expect(isGeneratedPath(path)).toBe(false)
    }
  })
})
