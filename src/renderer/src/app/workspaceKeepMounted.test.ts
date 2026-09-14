import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('the workspace stays keyed on the repository root, not the world', () => {
  // The stage moved out of App.tsx in the P13 split; the rule it guards did not.
  const source = readFileSync(fileURLToPath(new URL('./WorkspaceRootHost.tsx', import.meta.url)), 'utf8')
  expect(source).toContain('workspaceKey={snapshot.root}')
  expect(source).not.toMatch(/worldId \?\? 'desk'/)
})

test('explicit review reload still remounts MultiFileReview, world switch does not', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./RepositoryWorkspace.tsx', import.meta.url)),
    'utf8'
  )
  expect(source).toContain('key={reviewSessionRevision}')
  expect(source).not.toMatch(/key=\{`\$\{reviewIdentity\}:\$\{reviewSessionRevision\}`\}/)
})

test('cached world CodeViews stay mounted in a capped Activity keep-alive', () => {
  const review = readFileSync(
    fileURLToPath(new URL('../review/MultiFileReview.tsx', import.meta.url)),
    'utf8'
  )
  const retained = readFileSync(
    fileURLToPath(new URL('../review/retainedWorldCodeView.tsx', import.meta.url)),
    'utf8'
  )
  expect(review).toContain('itemsForRetainedWorld')
  expect(review).toContain('<RetainedWorldCodeView')
  expect(review).not.toMatch(/<CodeView[\s\S]*items=\{annotatedItems\}/)
  expect(retained).toContain('retainWorldViewers')
  expect(retained).toContain('MAX_RETAINED_WORLD_VIEWERS')
  expect(retained).toContain("mode={active ? 'visible' : 'hidden'}")
  expect(retained).toContain('import {\n  Activity,')
})
