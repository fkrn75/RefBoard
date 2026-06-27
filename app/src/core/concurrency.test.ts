import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './concurrency'

describe('mapWithConcurrency', () => {
  it('preserves input order when resolving in parallel', async () => {
    const values = [3, 1, 2] as const

    const result = await mapWithConcurrency(values, 2, async (value) => value * 2)

    expect(result).toEqual([6, 2, 4])
  })
})
