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

type PathMatcher = (lowerPath: string, lowerName: string) => boolean

// A query is parsed once per filter pass, not once per path: rebuilding every
// glob's RegExp for each of 100k paths was most of the cost of a keystroke.
function compileFilterQuery(query: string): PathMatcher[] {
  return query.split(',').map((part) => part.trim()).filter((part) => part !== '')
    .map((pattern) => compilePathPattern(pattern.toLowerCase()))
}

function matchesAny(matchers: readonly PathMatcher[], path: string): boolean {
  if (matchers.length === 0) return true
  const haystack = path.toLowerCase()
  const name = haystack.slice(haystack.lastIndexOf('/') + 1)
  return matchers.some((matcher) => matcher(haystack, name))
}

export function pathMatchesFilterQuery(path: string, query: string): boolean {
  return matchesAny(compileFilterQuery(query), path)
}

export function applyReviewFileFilter(
  paths: readonly string[],
  filter: ReviewFileFilter
): readonly string[] {
  if (!reviewFileFilterIsActive(filter)) return paths
  const matchers = compileFilterQuery(filter.query)
  const next = paths.filter((path) => {
    if (filter.hideTests && isTestFilePath(path)) return false
    if (filter.hideApi && isApiFilePath(path)) return false
    return matchesAny(matchers, path)
  })
  // Filtering only drops paths, so an unchanged length is an unchanged list.
  return next.length === paths.length ? paths : next
}

function compilePathPattern(pattern: string): PathMatcher {
  const trimmed = pattern.replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return () => true
  if (!trimmed.includes('*') && !trimmed.includes('?')) return (path) => path.includes(trimmed)
  const regex = globToRegExp(normalizeGlob(trimmed))
  return (path, name) => regex.test(path) || regex.test(name)
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
