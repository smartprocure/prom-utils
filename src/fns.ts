import _debug from 'debug'
import { sumBy } from 'lodash'
import makeError from 'make-error'
import { size } from 'obj-walker'

import {
  Deferred,
  QueueOptions,
  QueueResult,
  ThroughputLimiterOptions,
  WaitOptions,
} from './types'

const rl = _debug('prom-utils:rateLimit')
const tl = _debug('prom-utils:throughputLimiter')
const bq = _debug('prom-utils:batchQueue')
const pm = _debug('prom-utils:pacemaker')
const wu = _debug('prom-utils:waitUntil')

/**
 * Limit the concurrency of promises. This can be used to control
 * how many requests are made to a server, for example.
 *
 * ```typescript
 * const limiter = rateLimit(3)
 * for (const url of urls) {
 *   // Will wait for one promise to finish if limit is reached
 *   await limiter.add(fetch(url))
 * }
 * // Wait for unresolved promises to resolve
 * await limiter.finish()
 * ```
 */
export const rateLimit = <T = unknown>(limit: number) => {
  rl('limit: %d', limit)
  const set = new Set<Promise<T>>()
  /**
   * Add a promise. Returns immediately if limit has not been
   * met. Waits for one promise to resolve if limit is met.
   */
  const add = async (prom: Promise<T>) => {
    // Add to set
    set.add(prom)
    rl('set size: %d', set.size)
    // Create a child promise
    // See: https://runkit.com/dubiousdavid/handling-promise-rejections
    prom.then(
      () => {
        rl('delete')
        // Remove from the set after resolving
        set.delete(prom)
      },
      // Handle the exception so we don't throw an UnhandledPromiseRejection exception
      () => rl('exception thrown')
    )
    // Limit was reached
    if (set.size === limit) {
      rl('limit reached: %d', limit)
      // Wait for one item to finish
      await Promise.race(set)
    }
  }
  /**
   * Wait for all promises to resolve
   */
  const finish = async () => {
    rl('finish')
    await Promise.all(set)
  }
  return { add, finish }
}

/**
 * Limit throughput by sleeping until the rate (units/sec)
 * is less than or equal to `maxUnitsPerSec`. Units is intentionally
 * abstract since it could represent records/sec or bytes/sec, for
 * example.
 *
 * Example:
 * ```typescript
 * const limiter = throughputLimiter(1000)
 *
 * for(const batch of batches) {
 *   // Will wait until the rate is <= `maxUnitsPerSec`
 *   await limiter.throttle(batch.length)
 *   console.log('Items/sec %d', limiter.getCurrentRate())
 * }
 * ```
 */
export const throughputLimiter = (
  maxUnitsPerSec: number,
  options: ThroughputLimiterOptions = {}
) => {
  const slidingWindow: { startTime: number; numItems: number }[] = []
  const windowLength = options.windowLength || 3
  const sleepTime = options.sleepTime || 100
  tl('init - maxUnitsPerSec %d', maxUnitsPerSec)
  tl('init - windowLength %d', windowLength)
  tl('init - sleepTime %d', sleepTime)

  /**
   * Get the current rate (items/sec). Returns 0 if `throttle` has not been
   * called.
   */
  const getCurrentRate = () => {
    tl('getCurrentRate called')
    if (slidingWindow.length > 0) {
      const { startTime } = slidingWindow[0]
      const numItems = sumBy(slidingWindow, 'numItems')
      tl('total items %d', numItems)
      const rate = numItems / ((new Date().getTime() - startTime) / 1000)
      tl('current rate %d', rate)
      return rate
    }
    tl('current rate 0')
    return 0
  }

  /**
   * Call before processing a batch of items. After the first call, a subsequent
   * call assumes that the `numItems` from the previous call were processed. A
   * call to `throttle` may sleep for a given period of time depending on
   * `maxUnitsPerSec` and the total number of items over the current window.
   */
  const throttle = async (numItems: number) => {
    tl('throttle called - %d', numItems)
    // Skip check if maxUnitsPerSec is Infinity
    if (maxUnitsPerSec === Infinity) {
      tl('exiting throttle - maxUnitsPerSec is Infinity')
      return
    }
    while (getCurrentRate() > maxUnitsPerSec) {
      tl('sleeping for %d', sleepTime)
      await sleep(sleepTime)
    }
    slidingWindow.push({ startTime: new Date().getTime(), numItems })
    if (slidingWindow.length > windowLength) {
      tl('truncating slidingWindow')
      slidingWindow.shift()
    }
    tl('slidingWindow %o', slidingWindow)
  }

  return {
    throttle,
    getCurrentRate,
  }
}

/**
 * Batch calls via a local queue. This can be used to batch values before
 * writing to a database, for example.
 *
 * Calls `fn` when either `batchSize`, `batchBytes`, or `timeout` is reached.
 * `batchSize` defaults to 500 and therefore will always be in effect if
 * no options are provided. You can pass `Infinity` to disregard `batchSize`.
 * If `timeout` is passed, the timer will be started when the first item is
 * enqueued and reset when `flush` is called explicitly or implicitly.
 *
 * Use `maxItemsPerSec` and/or `maxBytesPerSec` to limit throughput.
 * Call `queue.getStats()` to get the items/sec and bytes/sec rates.
 *
 * Call `queue.flush()` to flush explicitly.
 *
 * The last result of calling `fn` can be obtained by referencing `lastResult`
 * on the returned object.
 *
 * ```typescript
 * const writeToDatabase = async (records) => {...}
 *
 * const queue = batchQueue(writeToDatabase)
 * for (const record of records) {
 *   // Will call `fn` when a threshold is met
 *   await queue.enqueue(record)
 * }
 * // Call `fn` with remaining queued items
 * await queue.flush()
 * ```
 */
export function batchQueue<A, B>(
  fn: (arr: A[]) => B,
  options: QueueOptions = {}
) {
  const {
    batchSize = 500,
    timeout,
    maxItemsPerSec = Infinity,
    maxBytesPerSec = Infinity,
  } = options
  bq('options %o', options)
  let queue: A[] = []
  let timeoutId: ReturnType<typeof setTimeout>
  let prom: Promise<unknown>
  let bytes = 0
  // Limiters
  const itemsLimiter = throughputLimiter(maxItemsPerSec)
  const bytesLimiter = throughputLimiter(maxBytesPerSec)

  /**
   * Call fn on queue and clear the queue. A delay may occur before fn is
   * called if `maxItemsPerSec` or `maxBytesPerSec` are set and one of the
   * rates is above the given threshold.
   */
  const flush = async () => {
    bq('flush called - queue length %d', queue.length)
    // Clear the timeout
    clearTimeout(timeoutId)
    bq('clearTimeout called')
    // Wait for a timeout initiated flush to complete
    await prom
    // Queue is not empty
    if (queue.length) {
      // Wait for the throughput to drop below thresholds for items/sec
      // and bytes/sec limiters.
      await Promise.all([
        itemsLimiter.throttle(queue.length),
        bytesLimiter.throttle(bytes),
      ])
      // Call fn with queue
      const result = await fn(queue)
      bq('fn called')
      obj.lastResult = result
      // Reset the queue
      queue = []
      // Reset the size
      bytes = 0
      bq('queue reset')
    }
  }

  /**
   * Enqueue an item. If the batch size is reached wait
   * for queue to be flushed.
   */
  const enqueue = async (item: A) => {
    bq('enqueue called')
    // Wait for a timeout initiated flush to complete
    await prom
    // Start a timer if timeout is set and the queue is empty
    if (timeout && queue.length === 0) {
      timeoutId = setTimeout(() => {
        bq('setTimeout cb')
        prom = flush()
      }, timeout)
      bq('setTimeout called')
    }
    // Add item to queue
    queue.push(item)
    // Calculate total bytes if a bytes-related option is set
    if (options.batchBytes || maxBytesPerSec < Infinity) {
      bytes += size(item)
      bq('bytes %d', bytes)
    }
    // Batch size reached
    if (queue.length === batchSize) {
      bq('batchSize reached %d', queue.length)
      // Wait for queue to be flushed
      await flush()
    }
    // Batch bytes reached
    else if (options.batchBytes && bytes >= options.batchBytes) {
      bq('batchBytes reached %d', bytes)
      // Wait for queue to be flushed
      await flush()
    }
  }

  /**
   * Returns the current items/sec and bytes/sec values.
   * These will be zero if the corresponding option is not enabled.
   */
  const getStats = () => ({
    itemsPerSec: itemsLimiter.getCurrentRate(),
    bytesPerSec: bytesLimiter.getCurrentRate(),
  })

  const obj: QueueResult<A, B> = { flush, enqueue, getStats }
  return obj
}

/**
 * Defer resolving a promise until `done` is called.
 */
export function defer(): Deferred {
  let done = () => {}
  const promise = new Promise<void>((resolve) => {
    // Swap original done fn with promise resolve fn
    done = () => resolve()
  })
  return {
    done,
    promise,
  }
}

/**
 * Pause a loop by awaiting `proceed`. When `pause` is called `proceed` will
 * return a promise that is resolved when `resume` is called. Otherwise,
 * `proceed` will return immediately. If `timeout` is passed, `resume` will
 * be called after `timeout` if it is not manually called first.
 *
 * ```typescript
 * const shouldProcess = pausable()
 *
 * onSomeCondition(shouldProcess.pause)
 * onSomeOtherCondition(shouldProcess.resume)
 *
 * for (const record of records) {
 *   await shouldProcess.proceed()
 *   await processRecord(record)
 * }
 * ```
 */
export const pausable = (timeout?: number) => {
  let deferred: Deferred | undefined
  let timeoutId: ReturnType<typeof setTimeout>
  const pause = () => {
    deferred = defer()
    if (timeout) {
      timeoutId = setTimeout(() => deferred?.done(), timeout)
    }
  }
  const resume = () => {
    clearTimeout(timeoutId)
    deferred?.done()
  }
  const proceed = () => deferred?.promise
  return { pause, resume, proceed }
}

/**
 * Call heartbeatFn every interval until promise resolves or rejects.
 * `interval` defaults to 1000.
 *
 * Returns the value of the resolved promise.
 */
export const pacemaker = async <T>(
  heartbeatFn: () => void,
  promise: Promise<T>,
  interval = 1000
) => {
  const intervalId = setInterval(heartbeatFn, interval)

  try {
    return await promise
  } finally {
    clearInterval(intervalId)
    pm('interval cleared')
  }
}

export const TimeoutError = makeError('TimeoutError')

/**
 * Wait until the predicate returns truthy or the timeout expires.
 * Returns a promise.
 *
 * Will not hang like other implementations found on NPM.
 * Inspired by https://www.npmjs.com/package/async-wait-until
 */
export const waitUntil = (
  pred: () => Promise<boolean> | boolean,
  options: WaitOptions = {}
) =>
  new Promise<void>((resolve, reject) => {
    const checkFrequency = options.checkFrequency || 50
    const timeout = options.timeout || 5000
    let checkTimer: ReturnType<typeof setTimeout>
    let timeoutTimer: ReturnType<typeof setTimeout>

    // Start timeout timer if `timeout` is not set to Infinity
    if (timeout !== Infinity) {
      timeoutTimer = setTimeout(() => {
        wu('timeout')
        clearTimeout(checkTimer)
        reject(new TimeoutError(`Did not complete in ${timeout} ms`))
      }, timeout)
    }

    /**
     * Check the predicate for truthiness.
     */
    const check = async () => {
      wu('check called')
      try {
        if (await pred()) {
          wu('pred returned truthy')
          clearTimeout(checkTimer)
          clearTimeout(timeoutTimer)
          resolve()
        } else {
          checkLater()
        }
      } catch (e) {
        reject(e)
      }
    }

    /**
     * Check the predicate after `checkFrequency`.
     */
    const checkLater = () => {
      wu('checkLater called')
      checkTimer = setTimeout(check, checkFrequency)
    }
    check()
  })

/**
 * Sleep for `time` ms before resolving the Promise.
 */
export const sleep = (time = 0) =>
  new Promise((resolve) => setTimeout(resolve, time))
