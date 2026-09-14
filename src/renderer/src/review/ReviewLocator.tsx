import { IconRefresh, IconSearch, IconX } from '@pierre/icons'

import type { RecentFolder } from '../explorer/recentFolders'
import { ReviewFolderChip } from './ReviewFolderChip'

export function ReviewLocator({
  locator,
  busy,
  folderName,
  folderPath,
  recentFolders,
  onChange,
  onSubmit,
  onFolderSelect,
  onFolderChooseExisting
}: {
  locator: string
  busy: boolean
  folderName: string | null
  folderPath: string | null
  recentFolders: readonly RecentFolder[]
  onChange(locator: string): void
  onSubmit(): void
  onFolderSelect(path: string): void
  onFolderChooseExisting(): void
}): React.JSX.Element {
  return (
    <div className="review-locator">
      <ReviewFolderChip
        name={folderName}
        path={folderPath}
        disabled={busy}
        recentFolders={recentFolders}
        onSelect={onFolderSelect}
        onChooseExisting={onFolderChooseExisting}
      />
      <div className="global-search">
        <IconSearch aria-hidden="true" />
        <input
          name="review-locator"
          value={locator}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onSubmit()
          }}
          placeholder="Enter a GitHub pull request URL"
          aria-label="Open pull request URL"
          disabled={busy}
        />
        {busy ? <IconRefresh className="spin search-spinner" /> : null}
        {locator !== '' ? (
          <button className="clear-search" type="button" onClick={() => onChange('')}>
            <IconX /><span className="sr-only">Clear pull request URL</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
