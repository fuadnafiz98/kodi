export type SearchPreviewTokenKind = 'plain' | 'comment' | 'keyword' | 'string' | 'number' | 'literal' | 'type'

export interface SearchPreviewToken {
  text: string
  kind: SearchPreviewTokenKind
  match: boolean
}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'package', 'private',
  'protected', 'public', 'return', 'static', 'struct', 'switch', 'throw', 'trait', 'try', 'type',
  'typeof', 'var', 'void', 'while', 'with', 'yield'
])
const LITERALS = new Set(['false', 'nil', 'null', 'none', 'true', 'undefined'])
const HASH_COMMENT_EXTENSIONS = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'fish', 'yaml', 'yml', 'toml'])
const TOKEN_PATTERN = /(?:\/\/.*|\/\*.*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|[A-Za-z_$][\w$]*)/gi
const HASH_COMMENT_TOKEN_PATTERN = /(?:#.*|\/\/.*|\/\*.*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|[A-Za-z_$][\w$]*)/gi

function splitQueryMatches(token: Omit<SearchPreviewToken, 'match'>, query: string): SearchPreviewToken[] {
  if (query === '') return [{ ...token, match: false }]
  const normalizedText = token.text.toLowerCase()
  const pieces: SearchPreviewToken[] = []
  let start = 0
  while (start < token.text.length) {
    const matchIndex = normalizedText.indexOf(query, start)
    if (matchIndex < 0) {
      pieces.push({ ...token, text: token.text.slice(start), match: false })
      break
    }
    if (matchIndex > start) pieces.push({ ...token, text: token.text.slice(start, matchIndex), match: false })
    pieces.push({ ...token, text: token.text.slice(matchIndex, matchIndex + query.length), match: true })
    start = matchIndex + query.length
  }
  return pieces
}

function classifyToken(text: string): SearchPreviewTokenKind {
  const normalized = text.toLowerCase()
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('#')) return 'comment'
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) return 'string'
  if (/^(?:0x[\da-f]+|\d)/i.test(text)) return 'number'
  if (KEYWORDS.has(normalized)) return 'keyword'
  if (LITERALS.has(normalized)) return 'literal'
  if (/^[A-Z]/.test(text)) return 'type'
  return 'plain'
}

export function tokenizeSearchPreview(path: string, preview: string, query: string): SearchPreviewToken[] {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  const normalizedQuery = query.trim().toLowerCase()
  const pattern = HASH_COMMENT_EXTENSIONS.has(extension) ? HASH_COMMENT_TOKEN_PATTERN : TOKEN_PATTERN
  const tokens: Array<Omit<SearchPreviewToken, 'match'>> = []
  let start = 0
  for (const match of preview.matchAll(pattern)) {
    const matchIndex = match.index
    if (matchIndex > start) tokens.push({ text: preview.slice(start, matchIndex), kind: 'plain' })
    tokens.push({ text: match[0], kind: classifyToken(match[0]) })
    start = matchIndex + match[0].length
  }
  if (start < preview.length) tokens.push({ text: preview.slice(start), kind: 'plain' })
  return tokens.flatMap((token) => splitQueryMatches(token, normalizedQuery))
}
