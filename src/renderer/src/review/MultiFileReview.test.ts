import { describe, expect, test } from 'bun:test'

import type { CodeViewItem } from '@pierre/diffs'

import {
  annotationSignature,
  deriveAnnotatedReviewItems,
  planAnnotatedReviewItemMutations
} from './annotatedReviewItems'
import {
  applyImagePreviews,
  applyMarkdownPreviews,
  canPreviewMarkdownItem,
  createImageReviewItem,
  imageReviewFile,
  createPatchReviewItems,
  createReviewItem,
  findCollapseFollowItemId,
  findActiveReviewItemId,
  findNextUnreadReviewItemId,
  markdownItemSource,
  mergeReviewItems,
  orderReviewItems,
  retainReviewItems
} from './reviewItems'
import type { FileComparison, FileImagePreview } from '../../../shared/contracts'
import { agentSelectionForReviewItem, markdownPreviewScrollAnchor, reviewScrollAnchorTarget } from './MultiFileReview'
import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import type { RemoteReviewThread } from '../../../shared/contracts'

describe('createPatchReviewItems', () => {
  test('parses a GitHub unified diff into CodeView items on the same tick', () => {
    const patch = [
      'diff --git a/src/value.ts b/src/value.ts',
      'index 1111111..2222222 100644',
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
      '@@ -1,3 +1,4 @@',
      ' export const value = 1',
      '-export const next = 2',
      '+export const next = 3',
      '+export const extra = 4',
      ' export const keep = 5',
      'diff --git a/README.md b/README.md',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1 @@',
      '+# Review notes'
    ].join('\n') + '\n'

    const items = createPatchReviewItems(patch, 'pr-1092')
    expect(items.map((item) => item.id)).toEqual(['review:src/value.ts', 'review:README.md'])
    expect(items.every((item) => item.type === 'diff')).toBe(true)
  })

  test('parses a files-API rebuilt patch that only has hunks plus git headers', () => {
    const patch = [
      'diff --git a/src/page.tsx b/src/page.tsx',
      '--- a/src/page.tsx',
      '+++ b/src/page.tsx',
      '@@ -10,2 +10,3 @@',
      '   return (',
      '-    <main />',
      '+    <main>',
      '+      <h1>Ready</h1>',
      '    </main>'
    ].join('\n') + '\n'

    const items = createPatchReviewItems(patch, 'pr-files-api')
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('review:src/page.tsx')
  })

  test('captures exact old-side text and revision identity for the agent', () => {
    const patch = [
      'diff --git a/src/value.ts b/src/value.ts',
      `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
      '@@ -1,2 +1,2 @@',
      ' export const stable = true',
      '-export const value = 1',
      '+export const value = 2'
    ].join('\n') + '\n'
    const item = createPatchReviewItems(patch, 'pr-agent')[0]!

    expect(agentSelectionForReviewItem(item, 'src/value.ts', {
      start: 2,
      end: 2,
      side: 'deletions'
    })).toEqual({
      path: 'src/value.ts',
      startLine: 2,
      endLine: 2,
      side: 'deletions',
      selectedText: 'export const value = 1',
      blobOid: '1'.repeat(40)
    })
  })
})

describe('image review items', () => {
  const image: FileImagePreview = {
    old: null,
    new: {
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,aaa',
      byteLength: 12
    }
  }

  test('turns a binary image comparison into a file item with an image annotation', () => {
    const comparison: FileComparison = {
      path: 'assets/icon.png',
      mode: 'diff',
      status: 'untracked',
      oldFile: null,
      newFile: null,
      binary: true,
      oversized: false,
      image
    }
    const item = createReviewItem(comparison)
    expect(item?.type).toBe('file')
    expect(item?.id).toBe('review:assets/icon.png')
  })

  test('replaces an empty binary patch item once the preview arrives', () => {
    const empty = createPatchReviewItems(
      'diff --git a/assets/icon.png b/assets/icon.png\nnew file mode 100644\nBinary files /dev/null and b/assets/icon.png differ\n',
      'working-tree'
    )
    expect(empty[0]?.type).toBe('diff')
    const hydrated = applyImagePreviews(empty, new Map([['assets/icon.png', image]]))
    expect(hydrated[0]?.type).toBe('file')
    expect(hydrated[0]?.type === 'file' ? hydrated[0].file.cacheKey : null)
      .toBe(imageReviewFile('assets/icon.png', image).cacheKey)
  })

  test('keeps item identity when the same preview is applied again', () => {
    const item = createImageReviewItem('assets/icon.png', image)
    const again = applyImagePreviews([item], new Map([['assets/icon.png', image]]))
    expect(again[0]).toBe(item)
  })
})

describe('markdown review items', () => {
  const NEW_MD_PATCH = [
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/README.md',
    '@@ -0,0 +1,3 @@',
    '+# Review notes',
    '+',
    '+Everything renders.'
  ].join('\n') + '\n'

  const CHANGED_MD_PATCH = [
    'diff --git a/doc/guide.md b/doc/guide.md',
    'index 1111111..2222222 100644',
    '--- a/doc/guide.md',
    '+++ b/doc/guide.md',
    '@@ -10,3 +10,3 @@',
    ' kept context',
    '-old wording',
    '+new wording',
    ' trailing context'
  ].join('\n') + '\n'

  const fileItem = (path: string, contents: string): CodeViewItem<ReviewAnnotationMetadata> => ({
    id: `review:${path}`,
    type: 'file',
    file: { name: path, contents, cacheKey: contents }
  }) as CodeViewItem<ReviewAnnotationMetadata>

  test('only offers the toggle on markdown items that have content', () => {
    expect(canPreviewMarkdownItem(fileItem('note.md', '# Hi'))).toBe(true)
    expect(canPreviewMarkdownItem(fileItem('note.markdown', 'body'))).toBe(true)
    expect(canPreviewMarkdownItem(fileItem('note.ts', 'const a = 1'))).toBe(false)
    expect(canPreviewMarkdownItem(fileItem('note.md', ''))).toBe(false)
    // The image preview placeholder is not a markdown source.
    expect(canPreviewMarkdownItem(createImageReviewItem('pic.md', {
      old: null,
      new: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,aaa', byteLength: 12 }
    }))).toBe(false)
  })

  test('a new-file patch previews its complete additions', () => {
    const item = createPatchReviewItems(NEW_MD_PATCH, 'new-md')[0]!
    const resolved = markdownItemSource(item)
    expect(resolved?.partial).toBe(false)
    expect(resolved?.source).toBe('# Review notes\n\nEverything renders.\n')
  })

  test('a changed-file patch previews the touched sections and says so', () => {
    const item = createPatchReviewItems(CHANGED_MD_PATCH, 'changed-md')[0]!
    const resolved = markdownItemSource(item)
    expect(resolved?.partial).toBe(true)
    expect(resolved?.source).toBe('kept context\nnew wording\ntrailing context\n')
  })

  test('frontmatter is stripped and a deleted file previews its last contents', () => {
    const deleted = createPatchReviewItems([
      'diff --git a/old.md b/old.md',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/old.md',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      '----',
      '-title: Gone',
      '----',
      '-# Removed'
    ].join('\n') + '\n', 'deleted-md')[0]!
    expect(markdownItemSource(deleted)?.source).toBe('# Removed\n')
  })

  test('swaps the diff for a placeholder item carrying a markdown annotation', () => {
    const base = createPatchReviewItems(NEW_MD_PATCH, 'new-md')
    const previewed = applyMarkdownPreviews(base, new Set(['README.md']), new Map())
    expect(previewed[0]?.type).toBe('file')
    const annotation = (previewed[0] as { annotations?: { metadata?: ReviewAnnotationMetadata }[] })
      .annotations?.[0]?.metadata
    expect(annotation).toEqual({
      kind: 'markdown',
      source: '# Review notes\n\nEverything renders.\n',
      partial: false
    })
    // Untoggled paths keep their item identity.
    expect(applyMarkdownPreviews(base, new Set(['other.md']), new Map())).toBe(base)
  })

  test('keeps item identity when the same preview is applied again', () => {
    const base = createPatchReviewItems(NEW_MD_PATCH, 'new-md')
    const first = applyMarkdownPreviews(base, new Set(['README.md']), new Map())
    const second = applyMarkdownPreviews(first, new Set(['README.md']), new Map())
    expect(second).toBe(first)
  })

  test('a hydrated source replaces the partial preview only while its item is current', () => {
    const base = createPatchReviewItems(CHANGED_MD_PATCH, 'changed-md')
    const cacheKey = base[0]?.type === 'diff' ? base[0].fileDiff.cacheKey : undefined
    const hydrated = new Map([['doc/guide.md', { cacheKey, source: '# Full document' }]])
    const previewed = applyMarkdownPreviews(base, new Set(['doc/guide.md']), hydrated)
    const metadata = (previewed[0] as { annotations?: { metadata?: ReviewAnnotationMetadata }[] })
      .annotations?.[0]?.metadata
    expect(metadata).toEqual({ kind: 'markdown', source: '# Full document', partial: false })

    // A reloaded diff carries a different cache key, so the stale source is ignored.
    const reloaded = createPatchReviewItems(CHANGED_MD_PATCH, 'changed-md-v2')
    const stale = applyMarkdownPreviews(reloaded, new Set(['doc/guide.md']), hydrated)
    const staleMetadata = (stale[0] as { annotations?: { metadata?: ReviewAnnotationMetadata }[] })
      .annotations?.[0]?.metadata
    expect(staleMetadata).toMatchObject({ kind: 'markdown', partial: true })
    expect(staleMetadata).not.toMatchObject({ source: '# Full document' })
  })

  test('the markdown annotation survives derivation and suppresses comment annotations', () => {
    const base = applyMarkdownPreviews(
      createPatchReviewItems<ReviewAnnotationMetadata>(NEW_MD_PATCH, 'new-md'),
      new Set(['README.md']),
      new Map()
    )
    const thread: ReviewThread = {
      id: 'thread-1',
      body: 'note',
      lineNumber: 2,
      range: { start: 2, end: 2, side: 'additions' },
      replies: [],
      resolved: false
    }
    const derived = deriveAnnotatedReviewItems({
      items: base,
      threadsByPath: { 'README.md': [thread] },
      remoteThreadsByPath: new Map(),
      draftComment: null,
      pendingSelection: null,
      collapsedItemIds: new Set<string>(),
      annotationVersions: {},
      previousCache: new Map()
    })
    const kinds = (derived.items[0] as { annotations?: { metadata?: ReviewAnnotationMetadata }[] })
      .annotations?.map((annotation) => annotation.metadata?.kind)
    expect(kinds).toEqual(['markdown'])
  })
})

describe('multi-file review items', () => {
  test('keeps a background refresh anchor at the same viewport offset', () => {
    expect(reviewScrollAnchorTarget({ itemId: 'review:file.ts', viewportOffset: -240 }, 1_840)).toBe(2_080)
    expect(reviewScrollAnchorTarget({ itemId: 'review:file.ts', viewportOffset: 80 }, 40)).toBe(0)
  })

  test('lands a markdown preview toggle on the toggled file, not where the diff used to be', () => {
    // Measured: the rendered preview is about half the height of the diff it
    // replaces (8,188px to 4,662px), so the old scroll offset points past the
    // end of the file and the scroller clamps onto the next one. Zero offset
    // means the file's own top.
    const anchor = markdownPreviewScrollAnchor('review:plan.md')
    expect(anchor).toEqual({ itemId: 'review:plan.md', viewportOffset: 0 })
    expect(anchor == null ? null : reviewScrollAnchorTarget(anchor, 1_840)).toBe(1_840)
    expect(anchor == null ? null : reviewScrollAnchorTarget(anchor, 0)).toBe(0)
  })

  test('has nothing to scroll to when the path has no item', () => {
    expect(markdownPreviewScrollAnchor(null)).toBeNull()
    expect(markdownPreviewScrollAnchor(undefined)).toBeNull()
  })

  test('replaces duplicate IDs instead of passing duplicates to CodeView', () => {
    const first = { id: 'review:file.ts', type: 'file', file: { name: 'file.ts', contents: 'old', cacheKey: 'old' } } as CodeViewItem
    const replacement = { id: 'review:file.ts', type: 'file', file: { name: 'file.ts', contents: 'new', cacheKey: 'new' } } as CodeViewItem
    const merged = mergeReviewItems([first], [replacement])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(replacement)
  })

  test('follows the explorer path order instead of patch order', () => {
    const first = { id: 'review:src/page10.tsx', type: 'file' } as CodeViewItem
    const second = { id: 'review:app/page.tsx', type: 'file' } as CodeViewItem
    const third = { id: 'review:src/page2.tsx', type: 'file' } as CodeViewItem

    expect(orderReviewItems(
      [first, second, third],
      ['app/page.tsx', 'src/page2.tsx', 'src/page10.tsx']
    )).toEqual([second, third, first])
  })

  test('keeps unaffected item identities stable when one annotation changes', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      id: `review:file-${index}.ts`,
      type: 'file',
      file: { name: `file-${index}.ts`, contents: `${index}`, cacheKey: `${index}` }
    })) as CodeViewItem<ReviewAnnotationMetadata>[]
    const common = {
      items,
      threadsByPath: {},
      remoteThreadsByPath: new Map(),
      draftComment: null,
      pendingSelection: null,
      collapsedItemIds: new Set<string>()
    }
    const initial = deriveAnnotatedReviewItems({
      ...common,
      annotationVersions: {},
      previousCache: new Map()
    })
    const next = deriveAnnotatedReviewItems({
      ...common,
      annotationVersions: { 'file-25.ts': 1 },
      previousCache: initial.cache
    })

    const changedIndexes = next.items.flatMap((item, index) => item === initial.items[index] ? [] : [index])
    expect(changedIndexes).toEqual([25])

    const mutations = planAnnotatedReviewItemMutations(
      next.items,
      new Map(initial.items.map((item) => [item.id, item])),
      () => true
    )
    expect(mutations.additions).toHaveLength(0)
    expect(mutations.updates).toEqual([next.items[25]!])
    expect(mutations.removedIds).toEqual([])
    expect(mutations.appendOnly).toBe(true)
  })
})

describe('annotated review item versions', () => {
  const fileItem = (contents: string): CodeViewItem<ReviewAnnotationMetadata> => ({
    id: 'review:file.ts',
    type: 'file',
    file: { name: 'file.ts', contents, cacheKey: contents }
  }) as CodeViewItem<ReviewAnnotationMetadata>
  const common = {
    threadsByPath: {},
    remoteThreadsByPath: new Map(),
    draftComment: null,
    pendingSelection: null,
    collapsedItemIds: new Set<string>(),
    annotationVersions: {}
  }

  // CodeView.syncItemRecord treats an unchanged version as "keep what you have"
  // and drops the update, so a re-parsed file needs a new version to reach it.
  test('bumps the version when the same file is re-parsed with unchanged annotations', () => {
    const initial = deriveAnnotatedReviewItems({ ...common, items: [fileItem('old')], previousCache: new Map() })
    const next = deriveAnnotatedReviewItems({
      ...common,
      items: [fileItem('new')],
      previousCache: initial.cache,
      previousItems: initial.items
    })
    expect(next.items[0]).not.toBe(initial.items[0])
    expect(next.items[0]!.version).not.toBe(initial.items[0]!.version)
  })

  test('keeps the items array identity when nothing changed', () => {
    const items = [fileItem('same')]
    const initial = deriveAnnotatedReviewItems({ ...common, items, previousCache: new Map() })
    const next = deriveAnnotatedReviewItems({
      ...common,
      items,
      remoteThreadsByPath: new Map(),
      previousCache: initial.cache,
      previousItems: initial.items
    })
    expect(next.items).toBe(initial.items)
    expect(next.cache).toBe(initial.cache)
  })

  test('rebuilds when a remote thread arrives with the same identity-different shape', () => {
    const items = [fileItem('same')]
    const thread = (body: string): RemoteReviewThread => ({
      id: 'thread-1',
      path: 'file.ts',
      line: 4,
      startLine: null,
      side: 'RIGHT',
      resolved: false,
      outdated: false,
      comments: [{ id: 'comment-1', body, authorLogin: 'octocat', authorAvatarUrl: '', createdAt: '2026-01-01' }]
    })
    const initial = deriveAnnotatedReviewItems({
      ...common,
      items,
      remoteThreadsByPath: new Map([['file.ts', [thread('looks good')]]]),
      previousCache: new Map()
    })
    const unchanged = deriveAnnotatedReviewItems({
      ...common,
      items,
      remoteThreadsByPath: new Map([['file.ts', [thread('looks good')]]]),
      previousCache: initial.cache,
      previousItems: initial.items
    })
    expect(unchanged.items).toBe(initial.items)

    const edited = deriveAnnotatedReviewItems({
      ...common,
      items,
      remoteThreadsByPath: new Map([['file.ts', [thread('looks bad!')]]]),
      previousCache: initial.cache,
      previousItems: initial.items
    })
    expect(edited.items).not.toBe(initial.items)
    expect(edited.items[0]!.version).not.toBe(initial.items[0]!.version)
  })
})

describe('annotationSignature', () => {
  const range = { start: 1, end: 2, side: 'additions' as const }

  test('separates an in-place body edit of the same length', () => {
    const thread = (body: string): ReviewThread => ({
      id: 'thread-1', body, lineNumber: 1, range, replies: [], resolved: false
    })
    expect(annotationSignature([thread('aaaa')], [], null, null, false, 0))
      .not.toBe(annotationSignature([thread('aaab')], [], null, null, false, 0))
  })

  test('separates resolve, collapse and the draft range', () => {
    const thread: ReviewThread = {
      id: 'thread-1', body: 'note', lineNumber: 1, range, replies: [], resolved: false
    }
    const base = annotationSignature([thread], [], null, null, false, 0)
    expect(annotationSignature([{ ...thread, resolved: true }], [], null, null, false, 0)).not.toBe(base)
    expect(annotationSignature([thread], [], null, null, true, 0)).not.toBe(base)
    expect(annotationSignature([thread], [], range, null, false, 0)).not.toBe(base)
    expect(annotationSignature([thread], [], null, range, false, 0)).not.toBe(base)
    expect(annotationSignature([thread], [], null, null, false, 1)).not.toBe(base)
  })

  test('catches an edit at either end of a long body', () => {
    const long = (body: string): ReviewThread[] => [{
      id: 'thread-1', body, lineNumber: 1, range, replies: [], resolved: false
    }]
    const filler = 'x'.repeat(400)
    const base = annotationSignature(long(`head${filler}tail`), [], null, null, false, 0)
    expect(annotationSignature(long(`HEAD${filler}tail`), [], null, null, false, 0)).not.toBe(base)
    expect(annotationSignature(long(`head${filler}TAIL`), [], null, null, false, 0)).not.toBe(base)
    expect(annotationSignature(long(`head${filler}tail!`), [], null, null, false, 0)).not.toBe(base)
  })

  test('is stable across identity-different but equal input', () => {
    const thread = (): ReviewThread => ({
      id: 'thread-1', body: 'note', lineNumber: 1, range, replies: [{ id: 'r1', body: 'ack' }], resolved: false
    })
    expect(annotationSignature([thread()], [], null, null, false, 0))
      .toBe(annotationSignature([thread()], [], null, null, false, 0))
  })
})

describe('planAnnotatedReviewItemMutations', () => {
  const item = (path: string): CodeViewItem<ReviewAnnotationMetadata> => ({
    id: `review:${path}`,
    type: 'file',
    file: { name: path, contents: path, cacheKey: path }
  }) as CodeViewItem<ReviewAnnotationMetadata>

  const previousMap = (items: readonly CodeViewItem<ReviewAnnotationMetadata>[]) =>
    new Map(items.map((entry) => [entry.id, entry]))

  test('treats a pure append as append-only', () => {
    const first = item('a.ts')
    const second = item('b.ts')
    const mutations = planAnnotatedReviewItemMutations(
      [first, second],
      previousMap([first]),
      (id) => id === first.id
    )
    expect(mutations.appendOnly).toBe(true)
    expect(mutations.additions).toEqual([second])
    expect(mutations.removedIds).toEqual([])
  })

  test('reports a departed file and stops being append-only', () => {
    const first = item('a.ts')
    const second = item('b.ts')
    const mutations = planAnnotatedReviewItemMutations(
      [second],
      previousMap([first, second]),
      () => true
    )
    expect(mutations.removedIds).toEqual([first.id])
    expect(mutations.appendOnly).toBe(false)
  })

  test('is not append-only when a file joins the middle of the review', () => {
    const first = item('a.ts')
    const inserted = item('b.ts')
    const last = item('c.ts')
    const mutations = planAnnotatedReviewItemMutations(
      [first, inserted, last],
      previousMap([first, last]),
      (id) => id !== inserted.id
    )
    expect(mutations.additions).toEqual([inserted])
    expect(mutations.removedIds).toEqual([])
    expect(mutations.appendOnly).toBe(false)
  })

  test('is not append-only when the existing files are reordered', () => {
    const first = item('a.ts')
    const second = item('b.ts')
    const mutations = planAnnotatedReviewItemMutations(
      [second, first],
      previousMap([first, second]),
      () => true
    )
    expect(mutations.removedIds).toEqual([])
    expect(mutations.appendOnly).toBe(false)
  })
})

describe('retainReviewItems', () => {
  const item = (path: string): CodeViewItem => ({
    id: `review:${path}`,
    type: 'file',
    file: { name: path, contents: path, cacheKey: path }
  }) as CodeViewItem

  test('keeps the items whose path is still part of the review', () => {
    const kept = item('a.ts')
    const dropped = item('b.ts')
    expect(retainReviewItems([kept, dropped], ['a.ts', 'c.ts'])).toEqual([kept])
  })

  test('keeps review order rather than path order', () => {
    const first = item('b.ts')
    const second = item('a.ts')
    expect(retainReviewItems([first, second], ['a.ts', 'b.ts'])).toEqual([first, second])
  })

  test('drops everything when no path survives', () => {
    expect(retainReviewItems([item('a.ts')], [])).toEqual([])
  })
})

describe('multi-file explorer synchronization', () => {
  const positions = [
    { id: 'review:first.ts', top: 160 },
    { id: 'review:second.ts', top: 640 },
    { id: 'review:third.ts', top: 1_120 }
  ]

  test('keeps the first item active while the review summary is visible', () => {
    expect(findActiveReviewItemId(0, positions)).toBe('review:first.ts')
  })

  test('changes the active item after crossing a file boundary', () => {
    expect(findActiveReviewItemId(600, positions)).toBe('review:second.ts')
    expect(findActiveReviewItemId(1_080, positions)).toBe('review:third.ts')
  })

  test('aligns the next file only when the active file is collapsed', () => {
    const items = positions.map(({ id }) => ({ id }))
    expect(findCollapseFollowItemId('review:first.ts', 'review:first.ts', items))
      .toBe('review:second.ts')
    expect(findCollapseFollowItemId('review:first.ts', 'review:second.ts', items))
      .toBeNull()
    expect(findCollapseFollowItemId('review:third.ts', 'review:third.ts', items))
      .toBeNull()
  })

  test('advances from a viewed file to the next unread file', () => {
    const items = positions.map(({ id }) => ({ id }))
    expect(findNextUnreadReviewItemId(
      'review:first.ts',
      'review:first.ts',
      items,
      new Set(['second.ts'])
    )).toBe('review:third.ts')
    expect(findNextUnreadReviewItemId(
      'review:second.ts',
      'review:first.ts',
      items,
      new Set()
    )).toBeNull()
  })
})
