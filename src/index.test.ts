import { describe, expect, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import {
  defer,
  batchQueue,
  rateLimit,
  pausable,
  pacemaker,
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
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThan(900)
  })
  test('should finish awaiting remaining promises', async () => {
    expect.assertions(3)
    const limiter = rateLimit(3)
    const done: string[] = []
    const createProm = () =>
      setTimeout(1000, 'done').then((p) => {
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
  // This test is here to ensure that the rejected promise doesn't
  // throw an UnhandledPromiseRejection exception.
  test('rejections should bubble up .add', async () => {
    const limiter = rateLimit(3)
    // Shorter timeout to make sure that this rejects before the other promises resolve
    await limiter.add(
      setTimeout(5).then(() => {
        throw new Error('rejectedPromise')
      })
    )
    await limiter.add(setTimeout(10))
  })
  test('rejections should bubble up .finish', () => {
    expect.assertions(1)
    return expect(async () => {
      const limiter = rateLimit(3)
      await limiter.add(setTimeout(10))
      await limiter.add(
        setTimeout(10).then(() => {
          throw new Error('rejectedPromise')
        })
      )
      // Call finish before reaching the limit of 3
      await limiter.finish()
    }).rejects.toThrow('rejectedPromise')
  })
})

describe('batchQueue', () => {
  test('should batch items up to batchSize', async () => {
    expect.assertions(2)
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
  })
  test('should flush queue if timeout is reached before batchSize', async () => {
    expect.assertions(1)
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
    expect.assertions(1)
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
      await shouldProcess.proceed()
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
      await shouldProcess.proceed()
      await processRecord(record)
    }
    const endTime = new Date().getTime()
    const elapsed = endTime - startTime
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(records).toEqual(['Joe', 'Frank', 'Bob'])
  })
})

describe('defer', () => {
  test('should defer', async () => {
    expect.assertions(1)
    const delay = (milliseconds: number) => {
      const deferred = defer()
      global.setTimeout(deferred.done, milliseconds, '🦄')
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
  test('should throw if the timeout expires', async () => {
    expect.assertions(1)
    let isTruthy = false
    global.setTimeout(() => {
      isTruthy = true
    }, 250)
    await expect(
      waitUntil(async () => isTruthy, { timeout: 100 })
    ).rejects.toMatch('Did not complete in 100 ms')
  })
  test('exception in pred can be caught', async () => {
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
