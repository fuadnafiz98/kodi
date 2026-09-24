/**
 * @pierre/icons only ships its sparkles filled, which read as a heavy blot next
 * to the titlebar's outline glyphs. Same 16px grid and ~1.5px line as the set.
 */
export function IconSparklesOutline(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" {...props}>
      <path d="M6.5 4.25c.36 3.1 1.4 4.14 4.75 5.25-3.35 1.1-4.39 2.15-4.75 5.25-.36-3.1-1.4-4.14-4.75-5.25C5.1 8.4 6.14 7.35 6.5 4.25Z" />
      <path d="M12.25 1.25c.18 1.45.6 1.87 2 2.25-1.4.38-1.82.8-2 2.25-.18-1.45-.6-1.87-2-2.25 1.4-.38 1.82-.8 2-2.25Z" />
    </svg>
  )
}
