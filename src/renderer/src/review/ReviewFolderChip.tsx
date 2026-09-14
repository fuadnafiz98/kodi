import { useState } from 'react'
import { IconFolder } from '@pierre/icons'

import type { RecentFolder } from '../explorer/recentFolders'
import { FolderPicker } from '../explorer/FolderPicker'
import { preloadFolderCatalog } from '../explorer/folderPickerModel'

export function ReviewFolderChip({
  name,
  path,
  disabled,
  recentFolders,
  onSelect,
  onChooseExisting
}: {
  name: string | null
  path: string | null
  disabled: boolean
  recentFolders: readonly RecentFolder[]
  onSelect(path: string): void
  onChooseExisting(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = name == null || name === '' ? 'Choose folder' : name
  const ariaLabel = name == null || name === '' ? 'Choose project folder' : `Review in ${name}`
  return (
    <div className="folder-picker-host review-folder-host">
      <button
        className={`review-folder-chip ${open ? 'active' : ''}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onMouseEnter={preloadFolderCatalog}
        onFocus={preloadFolderCatalog}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={path ?? 'Choose the local checkout for this pull request'}
      >
        <IconFolder aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open ? (
        <FolderPicker
          recentFolders={recentFolders}
          openingPath={null}
          dialogLabel="Choose project folder"
          inputId="review-folder-picker-input"
          onClose={() => setOpen(false)}
          onSelect={(next) => {
            setOpen(false)
            onSelect(next)
          }}
          onUseExisting={() => {
            setOpen(false)
            onChooseExisting()
          }}
        />
      ) : null}
    </div>
  )
}
