import { describe, expect, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import { defer, batchQueue, rateLimit, pausable } from './fns'

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

describe('batchQueue', () => {
  test('should batch items up to batchSize', async () => {
    const calls: any[] = []
    const fn = async (records: any[]) => {
      calls.push(records)
    }
    const batchSize = 2

    const queue = batchQueue(fn, { batchSize })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank'], ['Bob']])
  })
  test('should flush queue if timeout is reached before batchSize', async () => {
    const calls: any[] = []
    const fn = async (records: any[]) => {
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
    const calls: any[] = []
    const fn = async (records: any[]) => {
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
    const calls: any[] = []
    const fn = async (records: any[]) => {
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
  test('should flush queue if batchBytes is reached', async () => {
    const calls: any[] = []
    const fn = async (records: any[]) => {
      calls.push(records)
    }
    const batchSize = 5
    const batchBytes = 8

    const queue = batchQueue(fn, { batchSize, batchBytes })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank'], ['Bob']])
  })
  test('should flush queue if batchSize is reached before batchBytes', async () => {
    const calls: any[] = []
    const fn = async (records: any[]) => {
      calls.push(records)
    }
    const batchSize = 2
    const batchBytes = 100

    const queue = batchQueue(fn, { batchSize, batchBytes })
    const records = ['Joe', 'Frank', 'Bob']

    for (const record of records) {
      await queue.enqueue(record)
    }
    await queue.flush()
    expect(calls).toEqual([['Joe', 'Frank'], ['Bob']])
  })
})

describe('pausable', () => {
  test('should pause and resume', async () => {
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
