import type { CodeViewItem } from '@pierre/diffs'

import { reviewFileSignature, type ViewedFileSignatures } from './viewedFileStorage'

// A path is only viewed while the item it was viewed against is still the one on
// screen: a file whose contents changed reads as unviewed again. Filtering here
// rather than deleting keeps that decision out of a render-phase state write.
export function buildViewedPathsKey<Metadata>(
  itemsByPath: ReadonlyMap<string, CodeViewItem<Metadata>>,
  viewedFiles: Readonly<ViewedFileSignatures>
): string {
  const paths: string[] = []
  for (const [path, signature] of Object.entries(viewedFiles)) {
    const item = itemsByPath.get(path)
    if (item != null && reviewFileSignature(item) === signature) paths.push(path)
  }
  return paths.sort().join('\0')
}

export function parseViewedPathsKey(key: string): ReadonlySet<string> {
  return new Set(key === '' ? [] : key.split('\0'))
}
