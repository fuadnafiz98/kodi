import type { RepositorySnapshot } from '../../../shared/contracts'

// The cached paint: a flat list of the last session's paths, on screen while
// the real workspace chunk is still arriving.
export function CachedWorkspaceFallback({
  snapshot,
  selectedPath,
  onSelectPath
}: {
  snapshot: RepositorySnapshot
  selectedPath: string | null
  onSelectPath(path: string): void
}): React.JSX.Element {
  return (
    <>
      <aside className="sidebar" aria-label={snapshot.name}>
        <div className="sidebar-heading">
          <div className="sidebar-heading-identity">
            <span>{snapshot.name}</span>
          </div>
        </div>
        <ul className="cached-workspace-tree">
          {snapshot.paths.slice(0, 120).map((path) => (
            <li key={path}>
              <button
                type="button"
                aria-current={path === selectedPath ? 'true' : undefined}
                onClick={() => onSelectPath(path)}
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="sidebar-resizer" aria-hidden="true" />
      <section className="diff-panel" />
    </>
  )
}
