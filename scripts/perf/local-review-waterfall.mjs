// First-file vs full-patch waterfall for desk, local-branch, and commit reviews.
//
//   bun scripts/perf/local-review-waterfall.mjs [fileCount] [restLineCount] [samples]
//
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'

import { parsePatchFiles } from '@pierre/diffs'

import { RepositoryService } from '../../src/main/repository.ts'

const FILE_COUNT = Number(process.argv[2] ?? 48)
const REST_LINE_COUNT = Number(process.argv[3] ?? 80)
const SAMPLES = Number(process.argv[4] ?? 5)

function gitEnv(repositoryPath) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: repositoryPath
  }
}

function runGit(repositoryPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryPath, ...args], {
      env: gitEnv(repositoryPath),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8')
      if (code !== 0 && code !== 1) {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `git ${args[0]} exited ${code}`))
        return
      }
      resolve(output)
    })
  })
}

function fileBody(label, lines) {
  return Array.from({ length: lines }, (_unused, index) => `${label} line ${index}`).join('\n') + '\n'
}

function filePath(index) {
  return `src/mod-${String(index).padStart(3, '0')}.ts`
}

async function createFixture(fileCount) {
  const root = await mkdtemp(join(tmpdir(), 'horus-local-review-waterfall-'))
  await runGit(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet'])
  await mkdir(join(root, 'src'), { recursive: true })
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(root, filePath(index)), fileBody('base', index === 0 ? 12 : REST_LINE_COUNT), 'utf8')
  }
  await runGit(root, ['add', '--all'])
  await runGit(root, [
    '-c', 'user.name=Horus Perf',
    '-c', 'user.email=perf@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Base'
  ])
  await runGit(root, ['switch', '--quiet', '-c', 'feature'])
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(root, filePath(index)), fileBody('feature', index === 0 ? 12 : REST_LINE_COUNT), 'utf8')
  }
  await runGit(root, ['add', '--all'])
  await runGit(root, [
    '-c', 'user.name=Horus Perf',
    '-c', 'user.email=perf@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Feature'
  ])
  const featureOid = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  await runGit(root, ['switch', '--quiet', 'main'])
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(root, filePath(index)), fileBody('desk', index === 0 ? 12 : REST_LINE_COUNT), 'utf8')
  }
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(root, `untracked-${index}.txt`), `new ${index}\n`, 'utf8')
  }
  return { root, featureOid, paths: Array.from({ length: fileCount }, (_unused, index) => filePath(index)) }
}

function median(values) {
  const sorted = [...values].toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function summarize(samples) {
  const keys = Object.keys(samples[0] ?? {})
  return Object.fromEntries(keys.map((key) => {
    const values = samples.map((sample) => sample[key]).filter((value) => typeof value === 'number')
    if (values.length === 0) {
      const first = samples[0]?.[key]
      if (typeof first === 'boolean') {
        return [key, samples.every((sample) => sample[key] === true)]
      }
      return [key, first ?? null]
    }
    return [key, {
      medianMs: Number(median(values).toFixed(2)),
      minMs: Number(Math.min(...values).toFixed(2)),
      maxMs: Number(Math.max(...values).toFixed(2))
    }]
  }))
}

function parseDurationMs(patch) {
  const startedAt = performance.now()
  let itemCount = 0
  for (const parsed of parsePatchFiles(patch, 'waterfall')) {
    itemCount += parsed.files.length
  }
  return { parseMs: performance.now() - startedAt, itemCount, patchBytes: Buffer.byteLength(patch) }
}

async function measureRawGit(root, paths) {
  const resolveStarted = performance.now()
  await runGit(root, ['rev-parse', 'HEAD'])
  const resolveMs = performance.now() - resolveStarted

  const firstStarted = performance.now()
  const firstPatch = await runGit(root, [
    'diff', '--no-color', '--find-renames', '--unified=3', 'HEAD', '--', paths[0]
  ])
  const firstFileGitMs = performance.now() - firstStarted

  const allStarted = performance.now()
  const allPatch = await runGit(root, [
    'diff', '--no-color', '--find-renames', '--unified=3', 'HEAD', '--', ...paths
  ])
  const allFilesGitMs = performance.now() - allStarted
  return { resolveMs, firstFileGitMs, allFilesGitMs, firstPatch, allPatch }
}

async function measureWorkingTree(root, paths) {
  const repository = new RepositoryService()
  const pages = []
  try {
    await repository.open(root)
    await repository.refresh()
    const startedAt = performance.now()
    const onProgress = (page) => {
      pages.push({
        atMs: performance.now() - startedAt,
        patchBytes: Buffer.byteLength(page.patch),
        omitted: page.omittedFiles.length
      })
    }
    const result = await repository.getWorkingTreePatch(paths, onProgress)
    const fullMs = performance.now() - startedAt
    const parsed = parseDurationMs(result.patch)
    return {
      firstIpcPageMs: pages[0]?.atMs ?? null,
      firstIpcPageBytes: pages[0]?.patchBytes ?? null,
      pageCount: pages.length,
      fullMs,
      ...parsed,
      firstPaintWaitedOnFullGitDiff: pages.length === 0
    }
  } finally {
    repository.dispose()
  }
}

async function measureBranch(root) {
  const repository = new RepositoryService()
  const pages = []
  try {
    await repository.open(root)
    const startedAt = performance.now()
    const onProgress = (progress) => {
      pages.push({
        kind: progress.kind,
        atMs: performance.now() - startedAt,
        patchBytes: typeof progress.patch === 'string'
          ? Buffer.byteLength(progress.patch)
          : Buffer.byteLength(progress.review?.patch ?? '')
      })
    }
    const review = await repository.getLocalBranchReview('main', 'feature', onProgress)
    const fullMs = performance.now() - startedAt
    const parsed = parseDurationMs(review.patch)
    const firstPage = pages.find((page) => page.kind === 'metadata' || page.kind === 'files')
    return {
      firstIpcPageMs: firstPage?.atMs ?? null,
      pageCount: pages.length,
      fullMs,
      fileCount: review.files.length,
      ...parsed,
      firstPaintWaitedOnFullGitDiff: pages.length === 0
    }
  } finally {
    repository.dispose()
  }
}

async function measureCommit(root, oid) {
  const repository = new RepositoryService()
  const pages = []
  try {
    await repository.open(root)
    const startedAt = performance.now()
    const onProgress = (progress) => {
      pages.push({
        kind: progress.kind,
        atMs: performance.now() - startedAt
      })
    }
    const review = await repository.getCommitReview(oid, onProgress)
    const fullMs = performance.now() - startedAt
    const parsed = parseDurationMs(review.patch)
    const firstPage = pages.find((page) => page.kind === 'metadata' || page.kind === 'files')
    return {
      firstIpcPageMs: firstPage?.atMs ?? null,
      pageCount: pages.length,
      fullMs,
      fileCount: review.files.length,
      ...parsed,
      firstPaintWaitedOnFullGitDiff: pages.length === 0
    }
  } finally {
    repository.dispose()
  }
}

const fixture = await createFixture(FILE_COUNT)
try {
  const rawSamples = []
  const deskSamples = []
  const branchSamples = []
  const commitSamples = []
  for (let sample = 0; sample < SAMPLES + 1; sample += 1) {
    const raw = await measureRawGit(fixture.root, fixture.paths)
    const desk = await measureWorkingTree(fixture.root, fixture.paths)
    const branch = await measureBranch(fixture.root)
    const commit = await measureCommit(fixture.root, fixture.featureOid)
    if (sample === 0) continue
    rawSamples.push({
      resolveMs: raw.resolveMs,
      firstFileGitMs: raw.firstFileGitMs,
      allFilesGitMs: raw.allFilesGitMs
    })
    deskSamples.push(desk)
    branchSamples.push(branch)
    commitSamples.push(commit)
  }

  const report = {
    fixture: {
      fileCount: FILE_COUNT,
      restLineCount: REST_LINE_COUNT,
      untrackedFiles: 4,
      firstFileLines: 12,
      samples: SAMPLES
    },
    rawGit: summarize(rawSamples),
    desk: summarize(deskSamples),
    branch: summarize(branchSamples),
    commit: summarize(commitSamples),
    interpretation: {
      firstPaintWaitedOnFullGitDiff: deskSamples.every((sample) => sample.firstPaintWaitedOnFullGitDiff),
      gitVsParse: {
        deskGitMedianMs: summarize(deskSamples).fullMs.medianMs,
        deskParseMedianMs: summarize(deskSamples).parseMs.medianMs,
        firstFileGitMedianMs: summarize(rawSamples).firstFileGitMs.medianMs,
        allFilesGitMedianMs: summarize(rawSamples).allFilesGitMs.medianMs
      }
    }
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await rm(fixture.root, { recursive: true, force: true })
}
