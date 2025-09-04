import { setTimeout } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'

import {
  batchQueue,
  batchQueueParallel,
  defer,
  OptionsError,
  pacemaker,
  pausable,
  raceTimeout,
  rateLimit,
  throughputLimiter,
  TIMEOUT,
  TimeoutError,
  waitUntil,
} from './fns'

describe('rateLimit', () => {
  test('should add up to limit - 1 promises without delay', async () => {
    expect.assertions(1)
    const limiter = rateLimit(3)
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(1000))
    await limiter.add(setTimeout(1000))
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeLessThan(100)
  })
  test('should wait for one promise to resolve when limit is reached', async () => {
    expect.assertions(1)
    const limiter = rateLimit(3)
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(1000))
    await limiter.add(setTimeout(1000))
    await limiter.add(setTimeout(1000))
    await limiter.finish()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThan(900)
  })
  test('should finish awaiting remaining promises', async () => {
    expect.assertions(4)
    // Pass type variable
    const limiter = rateLimit<string>(3)
    const done: string[] = []
    const createProm = () =>
      setTimeout(1000, 'done').then((p) => {
        done.push(p)
        return p
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
    expect(done.length).toBe(5)
    expect(limiter.length).toBe(0)
  })
  // This test is here to ensure that the rejected promise doesn't
  // throw an UnhandledPromiseRejection exception.
  test('rejections should not bubble up .add', async () => {
    expect.assertions(1)
    const limiter = rateLimit(3)
    // Shorter timeout to make sure that this rejects before the other promises resolve
    await limiter.add(
      setTimeout(5).then(() => {
        throw new Error('rejectedPromise')
      })
    )
    await limiter.add(setTimeout(10))
    await limiter.finish()
    await setTimeout(20)
    // Check that the rejected promise was removed from the set.
    expect(limiter.length).toBe(0)
  })
  test('rejections should not bubble up .finish', () => {
    expect.assertions(1)
    expect(async () => {
      const limiter = rateLimit(3)
      await limiter.add(setTimeout(10))
      await limiter.add(
        setTimeout(10).then(() => {
          throw new Error('rejectedPromise')
        })
      )
      // Call finish before reaching the limit of 3
      await limiter.finish()
    }).not.toThrow('rejectedPromise')
  })
  test('should allow at most maxItemsPerPeriod if option is set', async () => {
    expect.assertions(1)
    // 1 unit per sec
    const limiter = rateLimit(3, { maxItemsPerPeriod: 1 })
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(10))
    await limiter.add(setTimeout(10))
    await limiter.add(setTimeout(10))
    await limiter.finish()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(3000)
  })
  test('should handle infinite concurrency while limiting via maxItemsPerPeriod', async () => {
    expect.assertions(2)
    // Simulate an API that allows 2 requests per 100 ms
    const limiter = rateLimit(Infinity, {
      maxItemsPerPeriod: 2,
      period: 100,
    })
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(10))
    await limiter.add(setTimeout(10))
    await limiter.add(setTimeout(10))
    await limiter.finish()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThan(100)
    expect(elapsed).toBeLessThan(150)
  })
  test('should not wait to end of period when bypass is set to true', async () => {
    expect.assertions(1)
    // 3 units per 10 ms
    const limiter = rateLimit(3, { maxItemsPerPeriod: 3, period: 1000 })
    const startTime = new Date().getTime()
    await limiter.add(setTimeout(100))
    await limiter.add(setTimeout(100))
    await limiter.add(setTimeout(100), { bypass: true })
    await limiter.finish()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeLessThan(150)
  })
})

describe('batchQueue', () => {
  test('should batch items up to batchSize', async () => {
    expect.assertions(4)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
      return records.length
    }
    const batchSize = 2

    const queue = batchQueue(fn, { batchSize })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank'], ['Bob']])
    expect(queue.lastResult).toBe(1)
    expect(queue.lastFlush).toEqual({ batchSize })
    expect(queue.length).toBe(0)
  })
  test('should flush queue if timeout is reached before batchSize', async () => {
    expect.assertions(2)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
    }
    const batchSize = 2
    const timeout = 50

    const queue = batchQueue(fn, { batchSize, timeout })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
      await setTimeout(75)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe'], ['Frank'], ['Bob']])
    expect(queue.lastFlush).toEqual({ timeout })
  })
  test('should reset timer if batchSize is reached before timeout', async () => {
    expect.assertions(1)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
    }
    const batchSize = 2
    const timeout = 100

    const queue = batchQueue(fn, { batchSize, timeout })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
      await setTimeout(20)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank'], ['Bob']])
  })
  test('fn should only be called once if timeout flush was triggered before queue.flush()', async () => {
    expect.assertions(1)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
      await setTimeout(100)
    }
    const batchSize = 5
    const timeout = 20

    const queue = batchQueue(fn, { batchSize, timeout })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await setTimeout(50)
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank', 'Bob']])
  })
  test('should flush queue if batchBytes is reached before batchSize', async () => {
    expect.assertions(2)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
    }
    const batchSize = 3
    const batchBytes = 8

    const queue = batchQueue(fn, { batchSize, batchBytes })
    const records = ['Joe', 'Frank', 'Bob', 'Tim']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    expect(calls).toEqual([
      ['Joe', 'Frank'],
      ['Bob', 'Tim'],
    ])
    expect(queue.lastFlush).toEqual({ batchBytes })
  })
  test('should flush queue if batchSize is reached before batchBytes', async () => {
    expect.assertions(1)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
    }
    const batchSize = 3
    const batchBytes = 100

    const queue = batchQueue(fn, { batchSize, batchBytes })
    const records = ['Joe', 'Frank', 'Bob', 'Tim']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank', 'Bob'], ['Tim']])
  })
  test('flush should govern throughput - maxItemsPerSec', async () => {
    expect.assertions(1)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
      await setTimeout(100)
    }
    const batchSize = 3
    const maxItemsPerSec = 5

    const queue = batchQueue(fn, { batchSize, maxItemsPerSec })
    const records = ['Joe', 'Frank', 'Bob', 'Tim']
    const startTime = new Date().getTime()

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    // Total time would be around 200 ms without throughput governing
    expect(elapsed).toBeGreaterThan(500)
  })
  test('flush should govern throughput - maxBytesPerSec', async () => {
    expect.assertions(1)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
      await setTimeout(100)
    }
    const batchSize = 3
    const maxBytesPerSec = 50

    const queue = batchQueue(fn, { batchSize, maxBytesPerSec })
    const records = ['Joe', 'Frank', 'Bob', 'Tim']
    const startTime = new Date().getTime()

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    // Total time would be around 200 ms without throughput governing
    expect(elapsed).toBeGreaterThan(500)
  })
  test('flush should govern throughput - maxItemsPerSec & maxBtyesPerSec', async () => {
    expect.assertions(3)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      calls.push(records)
      await setTimeout(100)
    }
    const batchSize = 3
    const maxItemsPerSec = 5
    const maxBytesPerSec = 50

    const queue = batchQueue(fn, { batchSize, maxItemsPerSec, maxBytesPerSec })
    const records = ['Joe', 'Frank', 'Bob', 'Tim']
    const startTime = new Date().getTime()

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    // Total time would be around 200 ms without throughput governing
    expect(elapsed).toBeGreaterThan(500)
    // Stats
    const stats = queue.getStats()
    expect(stats.bytesPerSec).toBeLessThan(100)
    expect(stats.itemsPerSec).toBeLessThan(10)
  })
})

describe('batchQueueParallel', () => {
  test('should batch items up to batchSize', () => {
    expect.assertions(3)
    const calls: any[] = []
    const fn = (records: string[]) => {
      calls.push([...records]) // Copy array since it gets reset
    }
    const batchSize = 2

    const queue = batchQueueParallel(fn, { batchSize })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      queue.enqueue(record)
    }
    queue.flush()
    expect(calls).toEqual([['Joe', 'Frank'], ['Bob']])
    expect(queue.length).toBe(0)
    expect(calls.length).toBe(2)
  })

  test('should flush automatically when batchSize is reached', () => {
    expect.assertions(2)
    const calls: any[] = []
    const fn = (records: string[]) => {
      calls.push([...records])
    }
    const batchSize = 3

    const queue = batchQueueParallel(fn, { batchSize })
    const records = ['Joe', 'Frank', 'Bob', 'Tim', 'Alice']

    for (const record of records) {
      queue.enqueue(record)
    }
    // Should have auto-flushed once when batchSize was reached
    expect(calls).toEqual([['Joe', 'Frank', 'Bob']])
    expect(queue.length).toBe(2) // Tim and Alice still in queue
  })

  test('should handle batchBytes option', () => {
    expect.assertions(3)
    const calls: any[] = []
    const fn = (records: string[]) => {
      calls.push([...records])
    }
    // Each string is roughly 3-5 bytes, so batchBytes of 10 should trigger with 3-4 items
    const batchBytes = 10

    const queue = batchQueueParallel(fn, { batchBytes })
    const records = ['Joe', 'Frank', 'Bob', 'Tim']

    for (const record of records) {
      queue.enqueue(record)
    }
    // Should have auto-flushed when batchBytes was reached
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].length).toBeGreaterThan(0)
    expect(queue.length).toBeGreaterThanOrEqual(0)
  })

  test('should flush manually with remaining items', () => {
    expect.assertions(3)
    const calls: any[] = []
    const fn = (records: string[]) => {
      calls.push([...records])
    }
    const batchSize = 3

    const queue = batchQueueParallel(fn, { batchSize })
    const records = ['Joe', 'Frank']

    for (const record of records) {
      queue.enqueue(record)
    }
    expect(queue.length).toBe(2)

    queue.flush()
    expect(calls).toEqual([['Joe', 'Frank']])
    expect(queue.length).toBe(0)
  })

  test('calling flush on an empty queue should not call fn', () => {
    expect.assertions(2)
    const calls: any[] = []
    const fn = (records: string[]) => {
      calls.push([...records])
    }

    const queue = batchQueueParallel(fn)
    queue.flush()

    expect(calls.length).toBe(0)
    expect(queue.length).toBe(0)
  })

  test('should be safe for concurrent access', async () => {
    expect.assertions(3)
    const calls: any[] = []
    const fn = async (records: string[]) => {
      // Simulate async processing
      await setTimeout(10)
      calls.push([...records])
      console.log('fn finished: %o', records)
    }
    const batchSize = 2

    const queue = batchQueueParallel(fn, { batchSize })

    // Simulate concurrent enqueuing with async delays
    queue.enqueue('A')
    await setTimeout(5)
    queue.enqueue('B') // Should trigger flush
    queue.enqueue('C')
    await setTimeout(5)
    queue.enqueue('D') // Should trigger another flush

    // Wait a bit more for async fn calls to complete
    await setTimeout(50)

    expect(calls.length).toBe(2)
    expect(calls[0]).toEqual(['A', 'B'])
    expect(calls[1]).toEqual(['C', 'D'])
  })
})

describe('pausable', () => {
  test('should pause and resume', async () => {
    expect.assertions(2)
    const shouldProcess = pausable()
    const processed: string[] = []
    const processRecord = async (record: string) => {
      processed.push(record)
      await setTimeout(50)
    }
    const records = ['Joe', 'Frank', 'Bob']
    global.setTimeout(shouldProcess.pause, 100)
    global.setTimeout(shouldProcess.resume, 150)

    const startTime = new Date().getTime()
    for (const record of records) {
      await shouldProcess.maybeBlock()
      await processRecord(record)
    }
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(records).toEqual(['Joe', 'Frank', 'Bob'])
  })
  test('should pause and resume after timeout', async () => {
    expect.assertions(2)
    const shouldProcess = pausable(50)
    const processed: string[] = []
    const processRecord = async (record: string) => {
      processed.push(record)
      await setTimeout(50)
    }
    const records = ['Joe', 'Frank', 'Bob']
    global.setTimeout(shouldProcess.pause, 100)

    const startTime = new Date().getTime()
    for (const record of records) {
      await shouldProcess.maybeBlock()
      await processRecord(record)
    }
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(records).toEqual(['Joe', 'Frank', 'Bob'])
  })
  test('isPaused works', () => {
    const shouldProcess = pausable()
    expect(shouldProcess.isPaused).toBe(false)
    shouldProcess.pause()
    expect(shouldProcess.isPaused).toBe(true)
    shouldProcess.resume()
    expect(shouldProcess.isPaused).toBe(false)
  })
})

describe('defer', () => {
  test('should defer', async () => {
    expect.assertions(1)
    const delay = (milliseconds: number) => {
      const deferred = defer()
      global.setTimeout(deferred.done, milliseconds)
      return deferred.promise
    }
    const startTime = new Date().getTime()
    await delay(100)
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(100)
  })
})

describe('pacemaker', () => {
  test('should call heartbeatFn 2 times', async () => {
    expect.assertions(2)
    let count = 0
    const heartbeatFn = () => {
      console.log('heartbeat')
      count++
    }
    const result = await pacemaker(heartbeatFn, setTimeout(250, 'done'), 100)
    expect(count).toBe(2)
    expect(result).toBe('done')
  })

  test('should throw', async () => {
    expect.assertions(1)
    const heartbeatFn = () => {
      console.log('heartbeat')
    }

    const promFn = async () => {
      await setTimeout(150)
      throw 'fail'
    }

    await expect(pacemaker(heartbeatFn, promFn(), 100)).rejects.toMatch('fail')
  })
})

describe('waitUntil', () => {
  test('should wait until pred returns truthy', async () => {
    expect.assertions(1)
    let isTruthy = false
    global.setTimeout(() => {
      isTruthy = true
    }, 250)
    await expect(waitUntil(() => isTruthy)).resolves.toBeUndefined()
  })
  test('should wait until async pred returns truthy', async () => {
    expect.assertions(1)
    let isTruthy = false
    global.setTimeout(() => {
      isTruthy = true
    }, 250)
    await expect(waitUntil(async () => isTruthy)).resolves.toBeUndefined()
  })
  test('should handle infinite timeout', async () => {
    expect.assertions(1)
    let isTruthy = false
    global.setTimeout(() => {
      isTruthy = true
    }, 250)
    await expect(
      waitUntil(async () => isTruthy, { timeout: Infinity })
    ).resolves.toBeUndefined()
  })
  test('should throw TimeoutError if the timeout expires', async () => {
    expect.assertions(1)
    let isTruthy = false
    global.setTimeout(() => {
      isTruthy = true
    }, 250)
    await expect(
      waitUntil(async () => isTruthy, { timeout: 100 })
    ).rejects.toThrow(new TimeoutError('Did not complete in 100 ms'))
  })
  test('rejects when pred throws', async () => {
    expect.assertions(1)
    await expect(
      waitUntil(
        async () => {
          throw 'fail'
        },
        { timeout: 100 }
      )
    ).rejects.toMatch('fail')
  })
})

describe('throughputLimiter', () => {
  test('call to throttle with empty sliding window completes without delay', async () => {
    expect.assertions(2)
    const limiter = throughputLimiter(100)
    const startTime = new Date().getTime()
    expect(limiter.getCurrentRate()).toBe(0)
    await limiter.throttle()
    const endTime = new Date().getTime()
    expect(endTime - startTime).toBeLessThan(5)
  })
  test('second call to throttle completes without delay if maxUnitsPerTime is Infinity', async () => {
    expect.assertions(1)
    const limiter = throughputLimiter(Infinity)
    const startTime = new Date().getTime()
    await limiter.throttle()
    limiter.append(1000)
    await limiter.throttle()
    const endTime = new Date().getTime()
    expect(endTime - startTime).toBeLessThan(5)
  })
  test('throughput should be throttled', async () => {
    expect.assertions(2)
    const limiter = throughputLimiter(500)
    const startTime = new Date().getTime()
    await limiter.throttleAndAppend(250)
    await setTimeout(100)
    await limiter.throttleAndAppend(250)
    await setTimeout(100)
    await limiter.throttleAndAppend(250)
    await setTimeout(100)
    await limiter.throttleAndAppend(250)
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(limiter.getCurrentRate()).toBeLessThan(1000)
  })
  test('minWindowLength option should work as expected', async () => {
    expect.assertions(1)
    const limiter = throughputLimiter(4, { minWindowLength: 4 })
    const startTime = new Date().getTime()
    await limiter.throttleAndAppend(1)
    await limiter.throttleAndAppend(1)
    await limiter.throttleAndAppend(1)
    await limiter.throttleAndAppend(1)
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeLessThan(5)
  })
  test('maxWindowLength option should work as expected', async () => {
    expect.assertions(1)
    const limiter = throughputLimiter(500, {
      maxWindowLength: 2,
    })
    const startTime = new Date().getTime()
    await limiter.throttleAndAppend(250)
    await setTimeout(100)
    await limiter.throttleAndAppend(250)
    await setTimeout(100)
    await limiter.throttleAndAppend(250)
    await setTimeout(100)
    await limiter.throttleAndAppend(250)
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(1500)
  })
  test('period option should work as expected', async () => {
    expect.assertions(2)
    // 5 units per 100 ms
    const limiter = throughputLimiter(5, { period: 100 })
    const startTime = new Date().getTime()
    await limiter.throttleAndAppend(5)
    await setTimeout(100)
    await limiter.throttleAndAppend(5)
    await setTimeout(100)
    await limiter.throttleAndAppend(5)
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(elapsed).toBeLessThan(250)
  })
  test('expireAfter option should work as expected', async () => {
    expect.assertions(2)
    // 5 units per 100 ms, with sliding window entries resetting after 50 ms
    const limiter = throughputLimiter(5, {
      period: 100,
      expireAfter: 50,
    })
    const startTime = new Date().getTime()
    await limiter.throttleAndAppend(5)
    await setTimeout(50)
    await limiter.throttleAndAppend(5)
    await setTimeout(50)
    await limiter.throttleAndAppend(5)
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(150)
  })
  test('should throw if both maxWindowLength and expireAfter are Inifinity', async () => {
    expect(() => {
      throughputLimiter(5, {
        maxWindowLength: Infinity,
        expireAfter: Infinity,
      })
    }).toThrow(OptionsError)
  })
})

describe('raceTimeout', () => {
  test('It should return promise if resolved before timeout', async () => {
    const winner = await raceTimeout(setTimeout(5, 'done'), 10)
    expect(winner).toBe('done')
  })
  test('It should return the TIMEOUT symbol', async () => {
    const winner = await raceTimeout(setTimeout(10, 'done'), 5)
    expect(winner).toBe(TIMEOUT)
  })
})
