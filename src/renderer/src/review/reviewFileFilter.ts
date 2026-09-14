export interface ReviewFileFilter {
  query: string
  hideTests: boolean
  hideApi: boolean
}

export const EMPTY_REVIEW_FILE_FILTER: ReviewFileFilter = {
  query: '',
  hideTests: false,
  hideApi: false
}

const TEST_DIRECTORY = /(^|\/)(__tests__|tests?|spec)(\/|$)/i
const TEST_FILE = /\.(tests?|spec)\.[^/]+$/i
const TEST_PREFIX = /(^|\/)test_[^/]+$/i
const TEST_SUFFIX = /(_test|_spec)\.[^/]+$/i
const API_DIRECTORY = /(^|\/)api(\/|$)/i

export function isTestFilePath(path: string): boolean {
  return TEST_DIRECTORY.test(path) || TEST_FILE.test(path) || TEST_PREFIX.test(path) || TEST_SUFFIX.test(path)
}

export function isApiFilePath(path: string): boolean {
  return API_DIRECTORY.test(path)
}

export function reviewFileFilterIsActive(filter: ReviewFileFilter): boolean {
  return filter.hideTests || filter.hideApi || filter.query.trim() !== ''
}

export function pathMatchesFilterQuery(path: string, query: string): boolean {
  const patterns = query.split(',').map((part) => part.trim()).filter((part) => part !== '')
  if (patterns.length === 0) return true
  const haystack = path.toLowerCase()
  return patterns.some((pattern) => matchPathPattern(haystack, pattern.toLowerCase()))
}

export function applyReviewFileFilter(
  paths: readonly string[],
  filter: ReviewFileFilter
): readonly string[] {
  if (!reviewFileFilterIsActive(filter)) return paths
  const next = paths.filter((path) => {
    if (filter.hideTests && isTestFilePath(path)) return false
    if (filter.hideApi && isApiFilePath(path)) return false
    return pathMatchesFilterQuery(path, filter.query)
  })
  return next.length === paths.length && next.every((path, index) => path === paths[index])
    ? paths
    : next
}

function matchPathPattern(path: string, pattern: string): boolean {
  const trimmed = pattern.replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return true
  if (!trimmed.includes('*') && !trimmed.includes('?')) return path.includes(trimmed)
  const glob = normalizeGlob(trimmed)
  const regex = globToRegExp(glob)
  return regex.test(path) || regex.test(path.split('/').at(-1) ?? path)
}

function normalizeGlob(pattern: string): string {
  let glob = pattern.endsWith('/*') ? `${pattern.slice(0, -2)}/**` : pattern
  if (glob.includes('/') && !glob.startsWith('**/')) glob = `**/${glob}`
  return glob
}

function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 1
      if (pattern[index + 1] === '/') index += 1
      continue
    }
    if (character === '*') {
      source += '[^/]*'
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    if (/[.+^${}()|[\]\\]/.test(character ?? '')) source += `\\${character}`
    else source += character
  }
  source += '$'
  return new RegExp(source)
}
