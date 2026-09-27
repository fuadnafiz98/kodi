/**
 * @pierre/icons has no undo/redo pair; the clock and loop arrows that stood in
 * read as "history" and "repeat", and the clock was also Revert's icon. Same
 * 16px grid and ~1.5px line as the set.
 */
export function IconUndo(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5.25 2.75 2.25 5.75l3 3" />
      <path d="M2.5 5.75h6.75a4 4 0 0 1 0 8H7" />
    </svg>
  )
}

export function IconRedo(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m10.75 2.75 3 3-3 3" />
      <path d="M13.5 5.75H6.75a4 4 0 0 0 0 8H9" />
    </svg>
  )
}
