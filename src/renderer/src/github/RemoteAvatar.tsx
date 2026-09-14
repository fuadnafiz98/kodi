import { useEffect, useState } from 'react'

import './RemoteAvatar.css'

// The renderer is offline by CSP (`img-src 'self' data:`), so avatar bytes are
// fetched in the main process and arrive back as a `data:` URL. Authors repeat
// across a conversation's threads and reviews, so requests dedupe per session.
const pending = new Map<string, Promise<string | null>>()

export function loadRemoteAvatar(url: string): Promise<string | null> {
  let request = pending.get(url)
  if (request == null) {
    request = window.repository?.getAvatar(url).catch(() => null) ?? Promise.resolve(null)
    pending.set(url, request)
  }
  return request
}

export function RemoteAvatar({ url, login }: { url: string; login: string }): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setDataUrl(null)
    if (url === '') return
    let cancelled = false
    void loadRemoteAvatar(url).then((result) => {
      if (!cancelled && result != null) setDataUrl(result)
    })
    return () => { cancelled = true }
  }, [url])
  if (dataUrl == null || failed) {
    return (
      <span className="remote-avatar" aria-hidden="true">
        {(login.trimStart()[0] ?? '?').toUpperCase()}
      </span>
    )
  }
  return <img className="remote-avatar" src={dataUrl} alt="" onError={() => setFailed(true)} />
}
