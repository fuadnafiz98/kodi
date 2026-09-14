import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Replace a file's contents so that a crash leaves either the old bytes or the
 * new ones, never a truncated mix.
 *
 * `rename` alone does not give that guarantee. It is atomic with respect to
 * other readers, but on a crash or power loss the rename can reach the disk
 * before the data it points at, leaving a valid directory entry over an empty
 * or partial file. Durability needs three steps in order: fsync the temp file
 * so its bytes are on the device, rename it over the target, then fsync the
 * containing directory so the rename itself survives.
 *
 * The directory fsync is best-effort. Some filesystems reject `fsync` on a
 * directory handle, and a persisted-but-unsynced rename is still strictly
 * better than a partial write, so a failure there does not fail the write.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporaryPath, 'w')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  await syncDirectory(dirname(path))
}

export function writeFileAtomicSync(path: string, contents: string): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    const descriptor = openSync(temporaryPath, 'w')
    try {
      writeSync(descriptor, contents, null, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporaryPath, path)
  } catch (error) {
    try { unlinkSync(temporaryPath) } catch { /* Nothing to clean up. */ }
    throw error
  }
  syncDirectorySync(dirname(path))
}

/**
 * Move a file that could not be parsed aside instead of deleting it, so the
 * bytes that broke the parser are still available to look at. The quarantined
 * name carries the failure time; a clash within the same millisecond keeps the
 * existing quarantine rather than overwriting it.
 */
export function quarantineFile(path: string, now = Date.now()): string | null {
  const quarantinePath = `${path}.corrupt-${now}`
  try {
    renameSync(path, quarantinePath)
    return quarantinePath
  } catch {
    return null
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename still stands.
  }
}

function syncDirectorySync(directory: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // As above: best effort.
  } finally {
    if (descriptor != null) {
      try { closeSync(descriptor) } catch { /* Already gone. */ }
    }
  }
}
