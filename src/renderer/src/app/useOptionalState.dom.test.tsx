import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { useOptionalState } from './useOptionalState'

afterEach(cleanup)

let value = ''
let set: (next: string) => void = () => {}

function Probe({ controlled, onChange }: {
  controlled?: string
  onChange?(next: string): void
}): React.JSX.Element {
  const [current, setCurrent] = useOptionalState(controlled, 'initial', onChange)
  value = current
  set = setCurrent
  return <span>{current}</span>
}

test('without a prop the hook owns the value', () => {
  render(<Probe />)
  expect(value).toBe('initial')
  act(() => set('typed'))
  expect(value).toBe('typed')
})

test('with a prop the parent owns the value and only hears about changes', () => {
  const seen: string[] = []
  const { rerender } = render(<Probe controlled="from parent" onChange={(next) => seen.push(next)} />)
  expect(value).toBe('from parent')

  act(() => set('typed'))
  expect(seen).toEqual(['typed'])
  // The parent did not accept it, so the value on screen has not moved.
  expect(value).toBe('from parent')

  rerender(<Probe controlled="typed" onChange={(next) => seen.push(next)} />)
  expect(value).toBe('typed')
})
