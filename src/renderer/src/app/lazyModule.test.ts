import { expect, test } from 'bun:test'

import { createLazyModule } from './lazyModule'

test('a lazy module is fetched once, kept, and announced to its readers', async () => {
  let imports = 0
  const module = createLazyModule(async () => {
    imports += 1
    return { value: 42 }
  })
  let announced = 0
  module.subscribe(() => { announced += 1 })
  expect(module.get()).toBeNull()
  const [first, second] = await Promise.all([module.load(), module.load()])
  expect(first).toBe(second)
  expect(module.get()?.value).toBe(42)
  await module.load()
  expect(imports).toBe(1)
  expect(announced).toBe(1)
})

test('a failed fetch is asked for again next time', async () => {
  let attempts = 0
  const module = createLazyModule(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('offline')
    return { value: 1 }
  })
  await expect(module.load()).rejects.toThrow('offline')
  expect((await module.load()).value).toBe(1)
})
