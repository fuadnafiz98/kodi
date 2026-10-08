import type { NormalizedGuide } from '../../../shared/reviewGuide'
import { sectionLabel } from './guideOrder'

function counts(added: number, deleted: number): string {
  return [added > 0 ? `+${added}` : null, deleted > 0 ? `−${deleted}` : null].filter(Boolean).join(' ') || '±0'
}

/** The guide as Markdown, for pasting into a pull request or a chat. */
export function formatGuideMarkdown(guide: NormalizedGuide): string {
  const lines = [`# ${guide.title}`, '']
  if (guide.overview != null) lines.push(guide.overview, '')
  for (const section of guide.sections) {
    lines.push(`## ${sectionLabel(section)} · ${section.title}`, '', section.body, '')
    for (const file of section.files) {
      lines.push(file.home
        ? `- \`${file.path}\` ${counts(file.added, file.deleted)}`
        : `- \`${file.path}\` (see above)`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
