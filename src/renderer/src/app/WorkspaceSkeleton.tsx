interface SkeletonRow {
  id: string
  depth: number
  width: number
}

const CODE_ROWS: readonly SkeletonRow[] = [
  0.72, 0.41, 0.58, 0.86, 0.33, 0.64, 0.5, 0.78, 0.29, 0.69, 0.55, 0.83, 0.38, 0.6, 0.47, 0.74
].map((width, index) => ({ id: `code-${index}`, depth: 0, width }))

const SKELETON_CSS = `
.workspace-skeleton { min-width: 0; min-height: 0; }
.workspace-skeleton-rows { flex: 1; min-height: 0; overflow: hidden; padding: 6px 12px; display: flex; flex-direction: column; gap: 10px; }
.workspace-skeleton-code { padding: 16px var(--gutter); gap: 9px; }
.workspace-skeleton-bar { height: 9px; flex: none; border-radius: 4px; corner-shape: squircle; background: var(--control-fill); position: relative; overflow: hidden; }
.workspace-skeleton-toolbar { display: flex; align-items: center; gap: 10px; }
.workspace-skeleton-toolbar .workspace-skeleton-bar:first-child { width: 168px; }
.workspace-skeleton-toolbar .workspace-skeleton-bar:last-child { width: 96px; height: 8px; }
.workspace-skeleton-bar::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, var(--control-fill-hover) 50%, transparent 100%);
  transform: translateX(-100%);
  animation: workspace-skeleton-sweep 1400ms linear infinite;
}
@keyframes workspace-skeleton-sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .workspace-skeleton-bar::after { animation: workspace-skeleton-fade 1600ms ease-in-out infinite; animation-duration: 1600ms !important; animation-iteration-count: infinite !important; transform: none; }
  @keyframes workspace-skeleton-fade { 0%, 100% { opacity: 0; } 50% { opacity: 0.5; } }
}
`

function SkeletonBar({ width, indent }: { width: number; indent?: number }): React.JSX.Element {
  return <div className="workspace-skeleton-bar"
    style={{ width: `${Math.round(width * 100)}%`, marginInlineStart: indent == null ? undefined : `${indent}px` }} />
}

/**
 * Just the code rows — the fallback for the viewer chunk inside an already
 * mounted workspace, where the sidebar and toolbar are real.
 */
export function WorkspaceCodeSkeleton(): React.JSX.Element {
  return (
    <>
      <style href="workspace-skeleton" precedence="medium">{SKELETON_CSS}</style>
      <div className="workspace-skeleton-rows workspace-skeleton-code" role="status">
        <span className="sr-only">Preparing viewer…</span>
        {CODE_ROWS.map((row) => (
          <SkeletonBar key={row.id} width={row.width} />
        ))}
      </div>
    </>
  )
}
