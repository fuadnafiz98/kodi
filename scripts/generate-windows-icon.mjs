import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectDirectory = resolve(import.meta.dirname, '..')
const sourceIcon = join(projectDirectory, 'build', 'icon-source.png')
const windowsIcon = join(projectDirectory, 'build', 'icon.ico')
const linuxIconDirectory = join(projectDirectory, 'build', 'icons')
const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'kodi-icon-'))

try {
  const images = sizes.map((size) => {
    const output = join(temporaryDirectory, `${size}.png`)
    execFileSync('sips', ['-z', String(size), String(size), sourceIcon, '--out', output], { stdio: 'ignore' })
    return { size, data: readFileSync(output) }
  })

  const entries = images.filter(({ size }) => size <= 256)

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  let offset = header.length + entries.length * 16
  const directory = entries.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })

  writeFileSync(windowsIcon, Buffer.concat([header, ...directory, ...entries.map(({ data }) => data)]))

  mkdirSync(linuxIconDirectory, { recursive: true })
  for (const { size, data } of images) {
    writeFileSync(join(linuxIconDirectory, `${size}x${size}.png`), data)
  }

  console.log('Created build/icon.ico and build/icons/*.png')
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
