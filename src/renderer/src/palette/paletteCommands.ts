export type PaletteGroup = 'Commands' | 'Files' | 'Content' | 'Branches'

export interface PaletteEntry {
  id: string
  group: PaletteGroup
  title: string
  subtitle: string
  keybinding?: string
  disabledReason?: string
}

const WORD_BOUNDARY = /[^a-z0-9]/

/**
 * Ranks one string against a lowercase query. Lower is better, null is no match.
 * A prefix beats a word start beats a mid-word substring beats a subsequence,
 * which is the order a reader would guess when typing four letters of a label.
 */
export function paletteScore(haystack: string, query: string): number | null {
  if (query === '') return 0
  const target = haystack.toLowerCase()
  const index = target.indexOf(query)
  if (index === 0) return -200 + target.length / 1_000
  if (index > 0) {
    const startsWord = WORD_BOUNDARY.test(target[index - 1] ?? '')
    return (startsWord ? -100 : 0) + index + target.length / 1_000
  }

  let cursor = 0
  let score = 0
  let previous = -2
  for (const character of query) {
    const match = target.indexOf(character, cursor)
    if (match < 0) return null
    score += match === previous + 1 ? 1 : 8
    previous = match
    cursor = match + 1
  }
  return score + target.length / 1_000
}

// The subtitle is real signal ("Wrap or scroll long code lines") but a hit there
// must never outrank a hit on the label itself.
const SUBTITLE_PENALTY = 400

export function rankPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
  limit = 30
): PaletteEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  const scored: Array<{ entry: PaletteEntry; score: number; order: number }> = []
  for (const [order, entry] of entries.entries()) {
    const titleScore = paletteScore(entry.title, normalizedQuery)
    const subtitleScore = paletteScore(entry.subtitle, normalizedQuery)
    const score = titleScore ?? (subtitleScore == null ? null : subtitleScore + SUBTITLE_PENALTY)
    if (score == null) continue
    scored.push({ entry, score, order })
  }
  scored.sort((left, right) => left.score - right.score || left.order - right.order)
  return scored.slice(0, limit).map((result) => result.entry)
}

/** Result rows in render order, grouped but flattened so one index can drive selection. */
export function groupPaletteEntries(entries: readonly PaletteEntry[]): Array<{ group: PaletteGroup; entries: PaletteEntry[] }> {
  const groups: Array<{ group: PaletteGroup; entries: PaletteEntry[] }> = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last?.group === entry.group) last.entries.push(entry)
    else groups.push({ group: entry.group, entries: [entry] })
  }
  return groups
}

export function nextPaletteIndex(current: number, delta: number, count: number): number {
  if (count === 0) return 0
  return (current + delta + count) % count
}
