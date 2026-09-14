import { createContext, useContext, useEffect, useState } from 'react'

const REVIEW_CLOCK_INTERVAL_MS = 30_000
const ReviewClockContext = createContext(Date.now())

export function ReviewClockProvider({ children }: {
  children: React.ReactNode
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), REVIEW_CLOCK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  return <ReviewClockContext value={now}>{children}</ReviewClockContext>
}

export function useReviewClock(): number {
  return useContext(ReviewClockContext)
}
