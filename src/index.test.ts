import { describe, expect, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import { rateLimit } from './index'

describe('rateLimit', () => {
  test('should add up to limit - 1 promises without delay', async () => {
    const limiter = rateLimit(3)
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(1000))
    await limiter.add(setTimeout(1000))
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeLessThan(100)
  })
  test('should wait for one promise to resolve when limit is reached', async () => {
    const limiter = rateLimit(3)
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(1000))
    await limiter.add(setTimeout(1000))
    await limiter.add(setTimeout(1000))
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThan(900)
  })
  test('should finish awaiting remaining promises', async () => {
    const limiter = rateLimit(3)
    const done = []
    const createProm = () =>
      setTimeout(1000).then((p) => {
        done.push(p)
      })

    const startTime = new Date().getTime()
    for (let i = 0; i < 5; i++) {
      await limiter.add(createProm())
    }
    await limiter.finish()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(2000)
    expect(elapsed).toBeLessThan(3000)
    expect(done.length).toEqual(5)
  })
})
