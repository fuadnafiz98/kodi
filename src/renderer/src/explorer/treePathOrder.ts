// The explorer's row order comes from @pierre/trees, but the boot path only ever
// asks it one question: which file would be at the top? Answering that locally
// keeps the 145 KB path-store out of the chunk that runs before React mounts.
// The rules below are a port of the library's path-store sort: directories
// before files at each level, then a case-insensitive natural (digit-aware)
// comparison, then byte order as the tie-break. `treePathOrder.test.ts` pins the
// result against `prepareFileTreeInput`.

type NaturalToken = string | number

interface TreePathEntry {
  segments: string[]
  isDirectory: boolean
}

function isDigitCode(characterCode: number): boolean {
  return characterCode >= 48 && characterCode <= 57
}

function naturalTokens(value: string): NaturalToken[] {
  const tokens: NaturalToken[] = []
  let tokenStart = 0
  let index = 0
  while (index < value.length) {
    while (index < value.length && !isDigitCode(value.charCodeAt(index))) index += 1
    if (index >= value.length) break
    if (index > tokenStart) tokens.push(value.slice(tokenStart, index))
    let numberValue = 0
    while (index < value.length && isDigitCode(value.charCodeAt(index))) {
      numberValue = numberValue * 10 + (value.charCodeAt(index) - 48)
      index += 1
    }
    tokens.push(numberValue)
    tokenStart = index
  }
  if (tokenStart < value.length || tokens.length === 0) tokens.push(value.slice(tokenStart))
  return tokens
}

function compareNaturalTokens(left: NaturalToken[], right: NaturalToken[]): number {
  const tokenCount = Math.min(left.length, right.length)
  for (let index = 0; index < tokenCount; index += 1) {
    const leftToken = left[index]!
    const rightToken = right[index]!
    if (leftToken === rightToken) continue
    if (typeof leftToken === 'number' && typeof rightToken === 'number') {
      return leftToken < rightToken ? -1 : 1
    }
    const leftText = String(leftToken)
    const rightText = String(rightToken)
    if (leftText !== rightText) return leftText < rightText ? -1 : 1
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return 0
}

function compareSegments(left: string, right: string): number {
  const leftLower = left.toLowerCase()
  const rightLower = right.toLowerCase()
  const leftTokens = naturalTokens(leftLower)
  const rightTokens = naturalTokens(rightLower)
  const plainText = leftTokens.length === 1 && rightTokens.length === 1 &&
    typeof leftTokens[0] === 'string' && typeof rightTokens[0] === 'string'

  let comparison = 0
  if (plainText) {
    if (leftLower !== rightLower) comparison = leftLower < rightLower ? -1 : 1
  } else {
    comparison = compareNaturalTokens(leftTokens, rightTokens)
    if (comparison === 0 && leftLower !== rightLower) comparison = leftLower < rightLower ? -1 : 1
  }
  if (comparison !== 0) return comparison
  if (left === right) return 0
  return left < right ? -1 : 1
}

function parseTreePath(filePath: string): TreePathEntry {
  const isDirectory = filePath.endsWith('/')
  return {
    segments: (isDirectory ? filePath.slice(0, -1) : filePath).split('/'),
    isDirectory
  }
}

/** A segment is a directory unless it is the last one of a file path. */
function kindAtDepth(entry: TreePathEntry, depth: number): number {
  if (depth !== entry.segments.length - 1) return 1
  return entry.isDirectory ? 1 : 0
}

function compareTreeEntries(left: TreePathEntry, right: TreePathEntry): number {
  const sharedDepth = Math.min(left.segments.length, right.segments.length)
  for (let depth = 0; depth < sharedDepth; depth += 1) {
    const leftSegment = left.segments[depth]!
    const rightSegment = right.segments[depth]!
    if (leftSegment === rightSegment) continue
    const leftKind = kindAtDepth(left, depth)
    if (leftKind !== kindAtDepth(right, depth)) return leftKind === 1 ? -1 : 1
    return compareSegments(leftSegment, rightSegment)
  }
  if (left.segments.length !== right.segments.length) {
    return left.segments.length < right.segments.length ? -1 : 1
  }
  if (left.isDirectory === right.isDirectory) return 0
  return left.isDirectory ? -1 : 1
}

export function compareTreePaths(left: string, right: string): number {
  return compareTreeEntries(parseTreePath(left), parseTreePath(right))
}

/**
 * The path the explorer puts first: folders before files, natural order within
 * each. Found with a single pass rather than a sort, because the tree order of
 * the other few thousand paths is never read here.
 */
export function firstTreePath(filePaths: readonly string[]): string | null {
  if (filePaths.length === 0) return null
  let best = filePaths[0]!
  let bestEntry = parseTreePath(best)
  for (let index = 1; index < filePaths.length; index += 1) {
    const candidate = filePaths[index]!
    const candidateEntry = parseTreePath(candidate)
    if (compareTreeEntries(candidateEntry, bestEntry) < 0) {
      best = candidate
      bestEntry = candidateEntry
    }
  }
  return best
}
