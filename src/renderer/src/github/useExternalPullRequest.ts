import { useEffect, useEffectEvent } from 'react'

/**
 * Cmd+H, a `kodi://` deep link and a pending URL left by a cold launch all
 * arrive here. Main resolves the local checkout, so `root` comes with the URL
 * and the renderer never probes for it again.
 */
export function useExternalPullRequest(
  openPullRequest: (url: string, root: string | null) => void
): void {
  const open = useEffectEvent(openPullRequest)
  useEffect(() => {
    const api = window.repository
    if (api == null) return undefined
    let opened: string | null = null
    const openOnce = (url: string, root: string | null): void => {
      if (opened === url) return
      opened = url
      open(url, root)
    }
    const stop = api.onOpenExternalPullRequest(openOnce)
    void api.getPendingExternalPullRequest().then((url) => {
      if (url != null) openOnce(url, null)
    })
    return stop
  }, [])
}
