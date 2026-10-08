import type { GuideFile, GuideSection, NormalizedGuide } from '../../../shared/reviewGuide'

export function guideFile(path: string, home = true, added = 2, deleted = 1): GuideFile {
  return { path, category: 'implementation', generated: false, added, deleted, home, focus: [] }
}

export function guideSection(number: number | null, title: string, files: GuideFile[]): GuideSection {
  return {
    id: `s${number ?? 'x'}`,
    number,
    title,
    body: `${title} body.`,
    kind: number == null ? 'supporting' : 'core',
    automatic: number == null,
    files,
    added: 0,
    deleted: 0,
    implementationAdded: 0,
    implementationDeleted: 0
  }
}

/** Two model sections and a Supporting one; `src/b.ts` is listed twice, home in 01. */
export function testGuide(): NormalizedGuide {
  return {
    version: 1,
    kind: 'review-guide',
    title: 'Teach the parser comments',
    overview: 'Comments are now skipped.',
    sections: [
      guideSection(1, 'Parser', [guideFile('src/b.ts'), guideFile('src/a.ts')]),
      guideSection(2, 'Callers', [guideFile('src/c.ts'), guideFile('src/b.ts', false)]),
      guideSection(null, 'Tests', [guideFile('test/a.test.ts', true, 5, 0)])
    ],
    sectionCount: 2,
    totals: { added: 11, deleted: 3, implementationAdded: 6, implementationDeleted: 3, files: 4 },
    facts: {
      generatedAt: '2026-10-08T00:00:00.000Z',
      provider: 'codex',
      model: 'gpt-test',
      scope: 'wt',
      subject: { tabId: 'desk:/repo', repositoryRoot: '/repo', source: 'workingTree' } as NormalizedGuide['facts']['subject']
    }
  }
}
