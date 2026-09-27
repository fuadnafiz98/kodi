import { expect, test } from 'bun:test'

import { createStreamCompletion } from './streamCompletion'

test('waiting resolves as soon as the stream reports done', async () => {
  const completion = createStreamCompletion()
  setTimeout(() => completion.markDone(), 5)
  expect(await completion.wait(1_000)).toBe(true)
  expect(completion.done).toBe(true)
})

test('a done that arrived before the reply needs no wait', async () => {
  const completion = createStreamCompletion()
  completion.markDone()
  expect(await completion.wait(0)).toBe(true)
})

test('a stream that never finishes stops holding the load after the timeout', async () => {
  const completion = createStreamCompletion()
  expect(await completion.wait(10)).toBe(false)
  expect(completion.done).toBe(false)
})
