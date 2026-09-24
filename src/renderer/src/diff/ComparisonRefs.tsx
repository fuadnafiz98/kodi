import { IconArrowRightShort } from '@pierre/icons'

const COMPARISON_SEPARATOR = ' → '

/**
 * `from → to` with a drawn arrow instead of the text glyph, whose weight and
 * baseline never matched the UI font. Screen readers hear "from to to".
 */
export function ComparisonRefs({ from, to }: { from: string; to: string }): React.JSX.Element {
  return (
    <>
      {from}
      <IconArrowRightShort className="comparison-arrow" aria-hidden="true" />
      <span className="sr-only"> to </span>
      {to}
    </>
  )
}

/** Renders a `from → to` label with the drawn arrow; any other label as-is. */
export function ComparisonLabel({ label }: { label: string }): React.JSX.Element {
  const separator = label.indexOf(COMPARISON_SEPARATOR)
  if (separator < 0) return <>{label}</>
  return <ComparisonRefs from={label.slice(0, separator)} to={label.slice(separator + COMPARISON_SEPARATOR.length)} />
}
