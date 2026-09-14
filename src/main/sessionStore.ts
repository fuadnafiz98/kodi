import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export type WindowThemeType = 'dark' | 'light'

export const MAX_PULL_REQUEST_FOLDERS = 40
const GITHUB_SLUG_PART = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/

export interface SessionState {
  lastRoot: string | null
  approvedRoots: string[]
  restoreLastFolder: boolean
  themeType: WindowThemeType
  /** Exact canvas color of the active theme; absent predates themed palettes. */
  windowBackground?: string | null
  pullRequestFolders: Record<string, string>
}

export const DEFAULT_SESSION_STATE: SessionState = {
  lastRoot: null,
  approvedRoots: [],
  restoreLastFolder: true,
  themeType: 'dark',
  windowBackground: null,
  pullRequestFolders: {}
}

const WINDOW_BACKGROUND_HEX = /^#[0-9a-f]{6}$/i

export function isWindowBackgroundHex(value: unknown): value is string {
  return typeof value === 'string' && WINDOW_BACKGROUND_HEX.test(value)
}

const FILE_NAME = 'last-session.json'
let pendingSave: Promise<void> = Promise.resolve()

export function parseSessionState(raw: unknown): SessionState {
  if (typeof raw !== 'object' || raw == null) return DEFAULT_SESSION_STATE
  const { lastRoot, approvedRoots, restoreLastFolder, themeType, windowBackground, pullRequestFolders } = raw as Record<string, unknown>
  const parsedLastRoot = typeof lastRoot === 'string' && lastRoot !== '' ? lastRoot : null
  return {
    lastRoot: parsedLastRoot,
    approvedRoots: Array.isArray(approvedRoots)
      ? [...new Set(approvedRoots.filter((root): root is string => typeof root === 'string' && root !== ''))]
      : parsedLastRoot == null ? [] : [parsedLastRoot],
    restoreLastFolder: typeof restoreLastFolder === 'boolean'
      ? restoreLastFolder
      : DEFAULT_SESSION_STATE.restoreLastFolder,
    themeType: themeType === 'light' ? 'light' : 'dark',
    windowBackground: isWindowBackgroundHex(windowBackground) ? windowBackground : null,
    pullRequestFolders: parsePullRequestFolders(pullRequestFolders)
  }
}

export function rememberedPullRequestFolder(state: SessionState, slug: string): string | null {
  return state.pullRequestFolders[slug.toLowerCase()] ?? null
}

export function rememberPullRequestFolder(
  state: SessionState,
  slug: string,
  root: string
): SessionState {
  const normalized = slug.toLowerCase()
  if (!isGithubRepoSlug(normalized) || !isAbsolute(root)) return state
  if (state.pullRequestFolders[normalized] === root) return state
  const pullRequestFolders = { ...state.pullRequestFolders }
  delete pullRequestFolders[normalized]
  pullRequestFolders[normalized] = root
  const keys = Object.keys(pullRequestFolders)
  if (keys.length > MAX_PULL_REQUEST_FOLDERS) {
    const oldest = keys[0]
    if (oldest != null) delete pullRequestFolders[oldest]
  }
  return { ...state, pullRequestFolders }
}

function isGithubRepoSlug(value: string): boolean {
  const separator = value.indexOf('/')
  if (separator <= 0 || value.indexOf('/', separator + 1) !== -1) return false
  const owner = value.slice(0, separator)
  const repository = value.slice(separator + 1)
  return GITHUB_SLUG_PART.test(owner) && GITHUB_SLUG_PART.test(repository)
}

function parsePullRequestFolders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return {}
  const folders: Record<string, string> = {}
  for (const [slug, root] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = slug.toLowerCase()
    if (!isGithubRepoSlug(normalized) || typeof root !== 'string' || !isAbsolute(root)) continue
    delete folders[normalized]
    folders[normalized] = root
    if (Object.keys(folders).length > MAX_PULL_REQUEST_FOLDERS) {
      const oldest = Object.keys(folders)[0]
      if (oldest != null) delete folders[oldest]
    }
  }
  return folders
}

/**
 * Synchronous because both values are needed before the first BrowserWindow
 * exists: the theme decides the window's background colour and the restore flag
 * decides whether to start opening a repository alongside it.
 */
export function loadSessionState(directory: string): SessionState {
  try {
    return parseSessionState(JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8')))
  } catch {
    return DEFAULT_SESSION_STATE
  }
}

export function saveSessionState(directory: string, state: SessionState): Promise<void> {
  const path = join(directory, FILE_NAME)
  const serialized = JSON.stringify(state, null, 2)
  pendingSave = pendingSave
    .then(() => writeFile(path, serialized, 'utf8'))
    .catch((error) => {
      console.error('Could not persist the last session:', error)
    })
  return pendingSave
}

export function flushSessionState(): Promise<void> {
  return pendingSave
}
