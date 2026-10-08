// Writes what `kodi --guide-format` prints into out/review-guide/, which
// electron-builder copies to Contents/Resources/review-guide/. The CLI `cat`s
// these files, so an agent reads the format without launching Electron.
//
//   bun scripts/write-guide-resources.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { GUIDE_FORMAT_TEXT } from '../src/main/reviewGuide/formatText'
import { GUIDE_SCHEMA } from '../src/main/reviewGuide/schema'

const directory = resolve(import.meta.dir, '..', 'out', 'review-guide')
await mkdir(directory, { recursive: true })
await writeFile(join(directory, 'format.md'), `${GUIDE_FORMAT_TEXT}\n`)
await writeFile(join(directory, 'schema.json'), `${JSON.stringify(GUIDE_SCHEMA, null, 2)}\n`)
console.log(`wrote ${directory}/format.md and schema.json`)
