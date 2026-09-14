interface SearchNavigationEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function getSearchNavigationDirection(event: SearchNavigationEvent): -1 | 0 | 1 {
  if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === 'ArrowDown') return 1
    if (event.key === 'ArrowUp') return -1
  }
  if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
    if (event.key.toLowerCase() === 'j') return 1
    if (event.key.toLowerCase() === 'k') return -1
  }
  return 0
}

export function moveSearchResultIndex(currentIndex: number, resultCount: number, direction: -1 | 1): number {
  if (resultCount === 0) return -1
  if (currentIndex < 0 || currentIndex >= resultCount) return direction === 1 ? 0 : resultCount - 1
  return (currentIndex + direction + resultCount) % resultCount
}
