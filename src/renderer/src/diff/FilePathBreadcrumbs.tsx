export function FilePathBreadcrumbs({ path }: { path: string }): React.JSX.Element {
  const segments = path.split('/')
  return (
    <nav className="editor-breadcrumbs" aria-label="File path">
      {segments.map((segment, index) => (
        <span key={`${segment}:${index}`}>
          {index > 0 ? <span className="breadcrumb-separator" aria-hidden="true">›</span> : null}
          <span>{segment}</span>
        </span>
      ))}
    </nav>
  )
}
