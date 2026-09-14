import type { FileComparison } from '../../../shared/contracts'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { showToast } from '../app/toast'

export const COPY_FILE_PATH_CSS = `
  [data-diffs-header] [data-title],
  [data-diffs-header] [data-prev-name] {
    cursor: pointer;
  }

  [data-diffs-header] [data-title]:hover,
  [data-diffs-header] [data-prev-name]:hover {
    text-decoration: underline dotted color-mix(in srgb, var(--diffs-fg) 45%, transparent);
    text-underline-offset: 3px;
  }
`

interface CopyPathBinding {
  onCopied: (path: string, copied: boolean) => void
  teardown(): void
}

const bindings = new WeakMap<HTMLElement, CopyPathBinding>()

function nameFromEvent(event: Event): string | null {
  const target = event.composedPath().find(
    (node): node is HTMLElement => node instanceof HTMLElement
      && (node.hasAttribute('data-title') || node.hasAttribute('data-prev-name'))
  )
  const name = target?.textContent?.trim()
  return name == null || name === '' ? null : name
}

export function copyTextToClipboard(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(() => true, () => false)
}

/**
 * Clicking a file name in a diff header copies its path. Only listeners
 * are attached here: writing into the item's rendered subtree during a render
 * pass desynchronizes the viewer's height accounting.
 */
export function syncCopyFilePathLifecycle(
  node: HTMLElement,
  phase: string,
  onCopied: (path: string, copied: boolean) => void
): void {
  if (phase === 'unmount') {
    bindings.get(node)?.teardown()
    bindings.delete(node)
    return
  }

  const existing = bindings.get(node)
  if (existing != null) {
    existing.onCopied = onCopied
    return
  }
  const root = node.shadowRoot
  if (root == null) return

  const binding: CopyPathBinding = { onCopied, teardown: () => undefined }

  const onClick = (event: Event): void => {
    const name = nameFromEvent(event)
    if (name == null) return
    event.preventDefault()
    event.stopPropagation()
    window.getSelection()?.removeAllRanges()
    void copyTextToClipboard(name).then((success) => binding.onCopied(name, success))
  }

  root.addEventListener('click', onClick, true)
  binding.teardown = () => root.removeEventListener('click', onClick, true)
  bindings.set(node, binding)
}

export function reportCopiedPath(path: string, copied: boolean): void {
  const name = path.split('/').at(-1) ?? path
  showToast(copied ? `Copied path · ${name}` : 'Could not copy path')
}

export function fileContentsToCopy(
  comparison: Pick<FileComparison, 'newFile' | 'oldFile' | 'binary' | 'oversized'>
): string | null {
  if (comparison.binary || comparison.oversized) return null
  return comparison.newFile?.contents ?? comparison.oldFile?.contents ?? null
}

export async function copyWorkingFileContents(path: string): Promise<void> {
  const name = path.split('/').at(-1) ?? path
  try {
    const comparison = await requireRepositoryApi().getComparison(path)
    const text = fileContentsToCopy(comparison)
    if (text == null) {
      showToast(comparison.binary ? `Cannot copy a binary file · ${name}` : 'Could not copy file contents')
      return
    }
    const copied = await copyTextToClipboard(text)
    showToast(copied ? `Copied contents · ${name}` : 'Could not copy file contents')
  } catch (error) {
    showToast(getErrorMessage(error) || 'Could not copy file contents')
  }
}
