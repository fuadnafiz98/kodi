import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A handler whose identity never changes but which always runs the latest
 * `handler`. The viewer's slot renderers close over these, and Pierre rebuilds
 * the portal of every rendered item whenever one of those renderers changes
 * identity — so a handler that only reads state when it is called must not drag
 * the renderers along each time that state moves. Only call the result from
 * events and effects: during render it would still hold the previous commit's
 * handler.
 */
export function useStableHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result
): (...args: Args) => Result {
  const handlerRef = useRef(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  })
  return useCallback((...args: Args) => handlerRef.current(...args), [])
}
