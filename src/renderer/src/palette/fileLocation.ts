/**
 * A path with a place in it, the way tools print one: `src/app.ts:42`,
 * `src/app.ts:42:7`, `src/app.ts#L42` (a GitHub link) or `src/app.ts(42,7)`.
 * The path is what the palette searches; the line is where the file opens.
 */
export interface FileLocationQuery {
  path: string
  line: number | null
  column: number | null
}

const LOCATION_SUFFIX = /(?::(\d+)(?::(\d+))?:?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?|\((\d+)(?:,\s*(\d+))?\))\s*$/

export function parseFileLocation(query: string): FileLocationQuery {
  const match = LOCATION_SUFFIX.exec(query)
  const line = match == null ? 0 : Number(match[1] ?? match[3] ?? match[5])
  if (match == null || line < 1) {
    // `src/app.ts:` is a line number on its way: search for the path meanwhile.
    const path = query.endsWith(':') ? query.slice(0, -1) : query
    return { path, line: null, column: null }
  }
  const column = match[2] ?? match[4] ?? match[6]
  return {
    path: query.slice(0, match.index).trimEnd(),
    line,
    column: column == null ? null : Number(column)
  }
}
