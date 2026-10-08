import type { GuideSection, NormalizedGuide } from '../../../shared/reviewGuide'
import type { GuideItemOrder } from './reviewGuideHost'

// The review's item id for a path. Repeated here rather than imported: the
// review module is on the startup path and this chunk must not reach into it.
export function guideItemId(path: string): string {
  return `review:${path}`
}

export interface GuideHomeFile {
  path: string
  itemId: string
  sectionIndex: number
}

/** Every file in the order the guide draws it: at its home section, as that section lists it. */
export function guideHomeFiles(guide: NormalizedGuide): GuideHomeFile[] {
  const files: GuideHomeFile[] = []
  const seen = new Set<string>()
  guide.sections.forEach((section, sectionIndex) => {
    for (const file of section.files) {
      if (!file.home || seen.has(file.path)) continue
      seen.add(file.path)
      files.push({ path: file.path, itemId: guideItemId(file.path), sectionIndex })
    }
  })
  return files
}

export function sectionLabel(section: GuideSection): string {
  return section.number == null ? 'Supporting' : String(section.number).padStart(2, '0')
}

/** The rank the review sorts by, and the pill on each section's first file. */
export function guideItemOrder(guide: NormalizedGuide): GuideItemOrder {
  const rank = new Map<string, number>()
  const pills = new Map<string, string>()
  const started = new Set<number>()
  for (const [index, file] of guideHomeFiles(guide).entries()) {
    rank.set(file.itemId, index)
    if (started.has(file.sectionIndex)) continue
    started.add(file.sectionIndex)
    const section = guide.sections[file.sectionIndex]!
    pills.set(file.itemId, `${sectionLabel(section)} · ${section.title}`)
  }
  return { rank, pills }
}

/**
 * Items in guide order: each file at its home section, files the guide does not
 * know (they appeared after it was written) at the end in load order. Items
 * not loaded yet are simply absent and slot in when their page lands.
 */
export function orderItemsByGuide<Item extends { id: string }>(
  items: readonly Item[],
  order: GuideItemOrder
): Item[] {
  const unknown = order.rank.size
  return items
    .map((item, index) => ({ item, key: order.rank.get(item.id) ?? unknown + index }))
    .sort((left, right) => left.key - right.key)
    .map(({ item }) => item)
}

/** The section whose files the item belongs to; null for a file the guide does not know. */
export function sectionIndexForItem(guide: NormalizedGuide, itemId: string | null): number | null {
  if (itemId == null) return null
  for (const file of guideHomeFiles(guide)) if (file.itemId === itemId) return file.sectionIndex
  return null
}
