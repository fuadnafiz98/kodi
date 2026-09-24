/**
 * The app mark reduced to a 16px glyph: two solid dots, and the two glass dots
 * joined by the rod, drawn duotone the way @pierre/icons draws its secondary
 * shapes. It stands for a tab that has nothing opened in it yet — Kodi itself.
 */
export function KodiGlyph(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" {...props}>
      <circle cx="4" cy="4" r="3" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="4" r="3" opacity=".42" />
      <circle cx="4" cy="12" r="3" opacity=".42" />
      <path d="M9.88 6.12 6.12 9.88" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  )
}
