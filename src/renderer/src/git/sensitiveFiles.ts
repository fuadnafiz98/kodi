import type { RepositoryStatusEntry } from '../../../shared/contracts'

// Its own module because the commit path in useGitWorkflow — reachable before
// the app mounts — needs only this check. Imported from gitChangesModel, it
// pulled that whole model, shared with the lazy Source Control panel, into the
// pre-mount bundle.

// Templates are meant to be shared; everything else in these families usually
// carries a credential.
const SAFE_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i
const SENSITIVE_NAME = /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.htpasswd|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk))$/i

/** A file name that usually holds a secret, e.g. `.env.local` or `deploy.pem`. */
export function looksSensitive(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return SENSITIVE_NAME.test(name) && !SAFE_TEMPLATE.test(name)
}

/**
 * Only files git has never seen are worth a warning: a tracked `.env` is
 * already in history, and nagging on every edit to it teaches people to click
 * through the one prompt that matters.
 */
export function sensitiveNewFiles(
  statuses: readonly RepositoryStatusEntry[],
  paths: ReadonlySet<string> | null = null
): string[] {
  const found: string[] = []
  for (const entry of statuses) {
    if (entry.status !== 'untracked' || (paths != null && !paths.has(entry.path))) continue
    if (looksSensitive(entry.path)) found.push(entry.path)
  }
  return found
}
