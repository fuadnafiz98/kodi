import { isGeneratedPath } from './generatedPaths.js'
import type { GuideFileCategory } from './reviewGuide.js'

/** What `.gitattributes` said about a path; absent fields were unspecified. */
export interface ReviewFileAttributes {
  /** The first `review-*` attribute set on the path. */
  category?: GuideFileCategory
  /** `linguist-generated`: true when set, false when unset or `false`. */
  generated?: boolean
}

export const REVIEW_CATEGORY_ATTRIBUTES: ReadonlyArray<readonly [string, GuideFileCategory]> = [
  ['review-implementation', 'implementation'],
  ['review-test', 'test'],
  ['review-documentation', 'documentation'],
  ['review-generated', 'generated'],
  ['review-agent-guidance', 'agent-guidance'],
  ['review-localization', 'localization'],
  ['review-assets', 'assets']
]

const AGENT_GUIDANCE_BASENAMES = new Set(['agents.md', 'claude.md', 'gemini.md', '.cursorrules', 'skill.md'])
const TEST_DIRECTORIES = new Set(['__tests__', 'test', 'tests', 'spec', 'specs', 'e2e', '__mocks__', 'fixtures'])
const TEST_BASENAMES = [
  /\.(test|spec)\.[^.]+$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /^test_.*\.py$/i,
  /(Test|Tests|Spec)\.(swift|kt|java|cs|scala)$/,
  /\.e2e\.[^.]+$/i
]
const LOCALIZATION_DIRECTORIES = new Set(['locale', 'locales', 'i18n', 'l10n', 'lang', 'translations'])
const LOCALIZATION_EXTENSIONS = new Set(['.po', '.pot', '.xliff', '.xlf', '.strings', '.stringsdict', '.arb'])
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.icns', '.mp4', '.mov', '.webm',
  '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.pdf'
])
// `changelog.ts` is code that writes a changelog, not one.
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h'
])
const DOCUMENTATION_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt'])

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf('.')
  return dot <= 0 ? '' : basename.slice(dot).toLowerCase()
}

/**
 * The category a reviewer would file a path under. Attributes win, then
 * `linguist-generated`, then the path itself; anything else is implementation.
 */
export function categorizePath(path: string, attributes: ReviewFileAttributes = {}): GuideFileCategory {
  if (attributes.category != null) return attributes.category
  if (attributes.generated === true) return 'generated'
  if (attributes.generated !== false && isGeneratedPath(path)) return 'generated'

  const segments = path.split('/')
  const basename = segments.at(-1) ?? path
  const lowerBasename = basename.toLowerCase()
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase())
  const lowerPath = path.toLowerCase()

  if (AGENT_GUIDANCE_BASENAMES.has(lowerBasename) ||
      lowerPath.startsWith('.cursor/rules/') || lowerPath.includes('/.cursor/rules/') ||
      directories.includes('.claude') || directories.includes('.codex') ||
      lowerPath === '.github/copilot-instructions.md' || lowerPath.endsWith('/.github/copilot-instructions.md')) {
    return 'agent-guidance'
  }
  if (directories.some((segment) => TEST_DIRECTORIES.has(segment)) ||
      TEST_BASENAMES.some((pattern) => pattern.test(basename))) {
    return 'test'
  }
  const extension = extensionOf(basename)
  if (directories.some((segment) => LOCALIZATION_DIRECTORIES.has(segment) || segment.endsWith('.lproj')) ||
      LOCALIZATION_EXTENSIONS.has(extension)) {
    return 'localization'
  }
  if (ASSET_EXTENSIONS.has(extension)) return 'assets'
  if (DOCUMENTATION_EXTENSIONS.has(extension) || directories.includes('docs') || directories.includes('doc') ||
      (/^(license|changelog|contributing)/i.test(basename) && !CODE_EXTENSIONS.has(extension))) {
    return 'documentation'
  }
  return 'implementation'
}
