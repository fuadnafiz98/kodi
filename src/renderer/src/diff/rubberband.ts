const RUBBERBAND_CONSTANT = 0.55

/**
 * Apple's rubber-band curve. Past a bound the surface keeps answering the pointer
 * but gives progressively less, which reads as "there is nothing more here"
 * instead of the frozen divider a hard clamp produces.
 *
 * `dimension` is the span the gesture happens in (the workspace width, the
 * viewport height); it sets how fast the resistance builds.
 */
export function rubberband(overshoot: number, dimension: number, constant = RUBBERBAND_CONSTANT): number {
  if (dimension <= 0) return 0
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

/** The live value during a drag. The committed value still uses a hard clamp. */
export function withResistance(raw: number, min: number, max: number, dimension: number): number {
  if (raw < min) return min - rubberband(min - raw, dimension)
  if (raw > max) return max + rubberband(raw - max, dimension)
  return raw
}
