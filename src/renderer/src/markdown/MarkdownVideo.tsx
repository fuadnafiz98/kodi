import { useEffect, useState } from 'react'

export function MarkdownVideo({
  href,
  label
}: {
  href: string
  label: string
}): React.JSX.Element {
  const [source, setSource] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const load = window.repository?.getMarkdownMedia
    if (load == null) {
      setSource(href)
      return
    }
    void load(href)
      .then((media) => {
        if (cancelled) return
        const copy = new Uint8Array(media.bytes.byteLength)
        copy.set(media.bytes)
        objectUrl = URL.createObjectURL(new Blob([copy], { type: media.mimeType }))
        setSource(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrl != null) URL.revokeObjectURL(objectUrl)
    }
  }, [href])

  if (failed || source == null) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    )
  }

  return (
    <span className="markdown-video">
      <video
        controls
        playsInline
        preload="metadata"
        src={source}
        aria-label={label}
        onError={() => setFailed(true)}
      />
      <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
    </span>
  )
}
