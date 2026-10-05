interface TextPosition {
  line: number
  character: number
}

export interface TextEdit {
  range: { start: TextPosition; end: TextPosition }
  newText: string
}

function positionAt(text: string, offset: number): TextPosition {
  let line = 0
  let lineStart = 0
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
    line += 1
    lineStart = index + 1
  }
  return { line, character: offset - lineStart }
}

/**
 * The one edit that turns `from` into `to`, covering only the span between
 * their common start and common end. Replacing the whole document instead put
 * the caret after the last line and scrolled the file to its bottom.
 */
export function minimalTextEdit(from: string, to: string): TextEdit | null {
  if (from === to) return null
  const shorter = Math.min(from.length, to.length)
  let start = 0
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start += 1
  let end = 0
  while (end < shorter - start
    && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end += 1
  return {
    range: { start: positionAt(from, start), end: positionAt(from, from.length - end) },
    newText: to.slice(start, to.length - end)
  }
}
