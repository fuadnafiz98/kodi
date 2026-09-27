// A file with nothing to diff is still a file to read. Whenever the one being
// read loses its changes — committed from a terminal or from Source Control,
// reverted — the reader must be shown its contents, not an empty review.
//
//   bun run build && bun run e2e file-contents
//
// What this suite was written against (see scripts/e2e/results/file-contents.jsonl):
//   - commit or revert the open file and the view dropped to "No files to review"
//     with the file still selected; only a second click on it showed it;
//   - a tab whose session was still activating asked for the file, was told
//     "Open a repository before using this action", and the loader dropped the
//     answer: the file sat selected over "Select a file in the explorer".
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, git, launchApp, press, removeLater, runSuite, writeTree } from './harness.mjs'

const deepAll = (selector) => `(() => {
  const found = []
  const walk = (root) => {
    for (const element of root.querySelectorAll(${JSON.stringify(selector)})) found.push(element)
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return found
})()`
const fileRow = (path) => `${deepAll(`[data-item-path="${path}"][data-item-type="file"]`)}[0]`
const reviewTop = `(() => {
  const scroller = document.querySelector('.multi-file-code-view')
  if (scroller == null) return null
  const top = scroller.getBoundingClientRect().top
  return ${deepAll('[data-diffs-header] [data-title]')}
    .map((title) => ({ path: title.textContent, y: title.getBoundingClientRect().top - top }))
    .filter((header) => header.y > -8 && header.y < 64)
    .sort((a, b) => a.y - b.y)[0]?.path ?? null
})()`
const inReview = (path) => `(${reviewTop}) === ${JSON.stringify(path)}`
// The file's own contents: the path bar names it, lines are on screen, and no
// state screen ("No files to review", "Select a file…") stands in for it.
const showsContents = (path) => `document.querySelector('.multi-file-code-view') == null
  && document.querySelector('.diff-state') == null
  && document.querySelector('.editor-breadcrumbs')?.textContent.replaceAll('›', '/') === ${JSON.stringify(path)}
  && ${deepAll('[data-line]')}.length > 0`
const source = (label, edited) => Array.from({ length: 120 }, (_unused, line) =>
  edited && line % 7 === 0 ? `export const ${label}${line} = 'edited'\n` : `export const ${label}${line} = ${line}\n`).join('')

const BUDGET = { settleMs: 800, rendererMs: 300, mainMs: 250, longTaskMs: 150 }

await runSuite('file-contents', async (suite, cleanup) => {
  const fixture = await createRepository('file-contents')
  cleanup(removeLater(fixture))
  await writeTree(fixture, 'lib', { top: 3, sub: 2, files: 2 })
  await mkdir(join(fixture, 'plans'), { recursive: true })
  await mkdir(join(fixture, 'docs'), { recursive: true })
  const changed = ['plans/a.md', 'plans/b.md', 'plans/c.ts', 'plans/d.ts', 'plans/e.ts', 'plans/f.ts']
  for (const path of changed) await writeFile(join(fixture, path), source(path.replace(/\W/g, '_'), false))
  await writeFile(join(fixture, 'docs/clean.md'), '# Clean\n\nNothing changed here.\n')
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  for (const path of changed) await writeFile(join(fixture, path), source(path.replace(/\W/g, '_'), true))

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app
  await cdp.waitFor(`${fileRow('plans/a.md')} != null`, 30_000, 16)

  const openInReview = async (path) => {
    await press(cdp, `${fileRow(path)}.click()`)
    await cdp.waitFor(inReview(path), 10_000, 16)
  }

  await openInReview('plans/a.md')
  await suite.watch(app, 'committing the open file from a terminal shows its contents',
    async () => {
      await git(fixture, 'add', 'plans/a.md')
      await git(fixture, 'commit', '--quiet', '-m', 'Commit a')
    },
    { ...BUDGET, done: showsContents('plans/a.md'), check: showsContents('plans/a.md'), timeoutMs: 8_000 })

  await openInReview('plans/b.md')
  await suite.watch(app, 'reverting the open file shows its contents',
    () => git(fixture, 'checkout', '--', 'plans/b.md'),
    { ...BUDGET, done: showsContents('plans/b.md'), check: showsContents('plans/b.md'), timeoutMs: 8_000 })

  await openInReview('plans/c.ts')
  await suite.watch(app, 'committing the open file from Source Control shows its contents', async () => {
    await git(fixture, 'add', 'plans/c.ts')
    await press(cdp, `document.querySelector('.source-control-titlebar-button').click()`)
    await cdp.waitFor(`document.querySelector('textarea[aria-label="Commit message"]') != null`, 10_000, 16)
    await press(cdp, `document.querySelector('textarea[aria-label="Commit message"]').focus()`)
    await cdp.send('Input.insertText', { text: 'Commit c' })
    // Only once the panel has seen the staged file does the button commit it
    // alone; before that it reads "Commit All" and means it.
    await cdp.waitFor(`document.querySelector('.scm-commit-button')?.disabled === false
      && document.querySelector('.scm-commit-button').textContent.trim() === 'Commit'`, 5_000, 16)
    await press(cdp, `document.querySelector('.scm-commit-button').click()`)
    await cdp.waitFor(`document.querySelector('textarea[aria-label="Commit message"]')?.value === ''`, 10_000, 16)
    await press(cdp, `document.querySelector('.source-control-titlebar-button').click()`)
  }, { ...BUDGET, timedAction: false, done: showsContents('plans/c.ts'), check: showsContents('plans/c.ts'), timeoutMs: 10_000 })

  // The reader clicked e, then scrolled on to f: committing e takes nothing away
  // from what they are reading.
  await openInReview('plans/e.ts')
  await Bun.sleep(1_200)
  // Scrolled on until the next file is the one on screen.
  await cdp.waitFor(`(() => {
    document.querySelector('.multi-file-code-view').scrollBy(0, 400)
    return ${inReview('plans/f.ts')}
  })()`, 10_000, 50)
  // A reader reads for a moment before a commit lands from elsewhere.
  await Bun.sleep(1_500)
  const reading = await cdp.eval(reviewTop)
  await suite.watch(app, 'committing a file scrolled past leaves the review on the file being read',
    async () => {
      await git(fixture, 'add', 'plans/e.ts')
      await git(fixture, 'commit', '--quiet', '-m', 'Commit e')
    },
    { ...BUDGET, settleMs: 2_000, check: `document.querySelector('.multi-file-code-view') != null
      && (${reviewTop}) === ${JSON.stringify(reading)}` })

  // Staging keeps the change against HEAD, so the diff stays.
  await openInReview('plans/d.ts')

  await suite.watch(app, 'staging the open file keeps its diff',
    () => git(fixture, 'add', 'plans/d.ts'),
    { ...BUDGET, settleMs: 2_000, check: inReview('plans/d.ts') })

  // A clean file inside a folder that is still closed.
  await cdp.combo('k', 'KeyK', 75, 4)
  await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
  await suite.watch(app, '⌘K to a clean file shows its contents', async () => {
    for (const character of 'docs/clean.md') {
      await cdp.send('Input.insertText', { text: character })
      await Bun.sleep(25)
    }
    await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')]
      .some((row) => row.textContent.includes('docs/clean.md'))`, 5_000, 16)
    const started = performance.now()
    await cdp.enter()
    return { slowestMs: performance.now() - started }
  }, { ...BUDGET, timedAction: false, done: showsContents('docs/clean.md'), check: showsContents('docs/clean.md') })

  // Back into the review from the single-file view, while the review's own
  // remembered offset sits on another file: the click wins. The review reloads
  // as it comes back, and its scroll restore used to land after the jump.
  await suite.watch(app, 'clicking a review file from the single-file view opens the review on it',
    () => press(cdp, `${fileRow('plans/f.ts')}.click()`),
    { ...BUDGET, done: inReview('plans/f.ts'), check: inReview('plans/f.ts') })
  await press(cdp, `document.querySelector('.multi-file-code-view').scrollTo(0, 0)`)
  await cdp.waitFor(inReview('plans/d.ts'), 5_000, 16)
  await cdp.combo('k', 'KeyK', 75, 4)
  await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
  for (const character of 'docs/clean.md') await cdp.send('Input.insertText', { text: character })
  await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')]
    .some((row) => row.textContent.includes('docs/clean.md'))`, 5_000, 16)
  await cdp.enter()
  await cdp.waitFor(showsContents('docs/clean.md'), 8_000, 16)
  await suite.watch(app, 'a second return from the single-file view lands on the clicked file, not the last offset',
    () => press(cdp, `${fileRow('plans/f.ts')}.click()`),
    { ...BUDGET, done: inReview('plans/f.ts'), check: inReview('plans/f.ts') })

  const banner = await cdp.tryEval(`document.querySelector('.error-banner')?.textContent ?? null`)
  suite.record('no error banner', banner == null, { banner })
})
