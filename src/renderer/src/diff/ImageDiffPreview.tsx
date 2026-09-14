import type { FileComparison, FileImagePreview, ImagePreviewSide } from '../../../shared/contracts'

interface ImageDiffPreviewProps {
  image: FileImagePreview
  status?: FileComparison['status']
}

interface PreviewColumn {
  key: 'old' | 'new'
  label: string
  side: ImagePreviewSide
}

export function ImageDiffPreview({ image, status }: ImageDiffPreviewProps): React.JSX.Element {
  const columns: PreviewColumn[] = []
  if (image.old != null) {
    columns.push({
      key: 'old',
      label: status === 'deleted' ? 'Removed' : 'Previous',
      side: image.old
    })
  }
  if (image.new != null) {
    columns.push({
      key: 'new',
      label: status === 'added' || status === 'untracked' ? 'Added' : 'Current',
      side: image.new
    })
  }

  return (
    <div className={columns.length > 1 ? 'image-diff-preview is-compare' : 'image-diff-preview'}>
      {columns.map((column) => (
        <figure key={column.key} className={`image-diff-side is-${column.key}`}>
          {columns.length > 1 ? <figcaption>{column.label}</figcaption> : null}
          <img
            src={column.side.dataUrl}
            alt={columns.length > 1 ? column.label : 'Image preview'}
            draggable={false}
          />
        </figure>
      ))}
    </div>
  )
}
