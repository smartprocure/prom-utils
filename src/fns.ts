import _debug from 'debug'
import { sumBy } from 'lodash'
import makeError from 'make-error'
import { size } from 'obj-walker'

import {
  Deferred,
  QueueOptions,
  QueueResult,
  SlidingWindowOptions,
  WaitOptions,
} from './types'

const debug = _debug('prom-utils')

/**
 * Limit the concurrency of promises. This can be used to control
 * how many requests are made to a server, for example.
 *
 * ```typescript
 * const limiter = rateLimit(3)
 * for (const url of urls) {
 *   await limiter.add(fetch(url))
 * }
 * await limiter.finish()
 * ```
 */
export const rateLimit = <T = unknown>(limit: number) => {
  debug('limit: %d', limit)
  const set = new Set<Promise<T>>()
  /**
   * Add a promise. Returns immediately if limit has not been
   * met. Waits for one promise to resolve if limit is met.
   */
  const add = async (prom: Promise<T>) => {
    // Add to set
    set.add(prom)
    debug('set size: %d', set.size)
    // Create a child promise
    // See: https://runkit.com/dubiousdavid/handling-promise-rejections
    prom.then(
      () => {
        debug('delete')
        // Remove from the set after resolving
        set.delete(prom)
      },
      // Handle the exception so we don't throw an UnhandledPromiseRejection exception
      () => debug('exception thrown')
    )
    // Limit was reached
    if (set.size === limit) {
      debug('limit reached: %d', limit)
      // Wait for one item to finish
      await Promise.race(set)
    }
  }
  /**
   * Wait for all promises to resolve
   */
  const finish = async () => {
    debug('finish')
    await Promise.all(set)
  }
  return { add, finish }
}

/**
 * Limit the throughput by sleeping until the rate (items/sec)
 * is less than `maxItemsPerSec`.
 *
 * Example:
 * ```typescript
 * const limiter = throughputLimiter(1000)
 *
 * for(const batch of batches) {
 *   await limiter.start(batch.length)
 *   console.log('Items/sec %d', limiter.getCurrentRate())
 * }
 * ```
 */
export const throughputLimiter = (
  maxItemsPerSec: number,
  options: SlidingWindowOptions = {}
) => {
  debug('maxItemsPerSec %d', maxItemsPerSec)
  const slidingWindow: { startTime: number; numItems: number }[] = []
  const windowLength = options.windowLength || 3
  const sleepTime = options.sleepTime || 100
  debug('windowLength %d', windowLength)
  debug('sleepTime %d', sleepTime)

  /**
   * Get the current rate (items/sec). Returns 0 if start has been called less
   * than two times.
   */
  const getCurrentRate = () => {
    debug('getCurrentRate called')
    if (slidingWindow.length > 0) {
      const { startTime } = slidingWindow[0]
      const numItems = sumBy(slidingWindow, 'numItems')
      debug('total items %d', numItems)
      const rate = numItems / ((new Date().getTime() - startTime) / 1000)
      debug('current rate %d', rate)
      return rate
    }
    debug('current rate 0')
    return 0
  }

  /**
   * Call before processing. After the first call, a subsequent call assumes
   * that the `numItems` from the previous call were processed. A call to
   * start may sleep for a given period of time depending on `maxItemsPerSec`
   * and the total number of items over the current window.
   */
  const start = async (numItems: number) => {
    debug('start called - %d', numItems)
    // Skip check if maxItemsPerSec is Infinity
    if (maxItemsPerSec < Infinity) {
      while (getCurrentRate() > maxItemsPerSec) {
        debug('sleeping for %d', sleepTime)
        await sleep(sleepTime)
      }
    }
    slidingWindow.push({ startTime: new Date().getTime(), numItems })
    if (slidingWindow.length > windowLength) {
      debug('truncating slidingWindow')
      slidingWindow.shift()
    }
    debug('slidingWindow %o', slidingWindow)
  }

  return {
    start,
    getCurrentRate,
  }
}

/**
 *
 * Batch calls via a local queue. This can be used to batch values before
 * writing to a database, for example.
 *
 * Calls `fn` when either `batchSize`, `batchBytes`, or `timeout` is reached.
 * `batchSize` defaults to 500 and therefore will always be in effect if
 * no options are provided. You can pass `Infinity` to disregard `batchSize`.
 * If `timeout` is passed, the timer will be started when the first item is
 * enqueued and reset when `flush` is called explicitly or implicitly.
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
 *   await queue.enqueue(record)
 * }
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
  debug('options %o', options)
  let queue: A[] = []
  let timeoutId: ReturnType<typeof setTimeout>
  let prom: Promise<unknown>
  let bytes = 0
  // Limiters
  const itemsLimiter = throughputLimiter(maxItemsPerSec)
  const bytesLimiter = throughputLimiter(maxBytesPerSec)

  /**
   * Call fn on queue and clear the queue.
   */
  const flush = async () => {
    debug('flush called - queue length %d', queue.length)
    // Clear the timeout
    clearTimeout(timeoutId)
    debug('clearTimeout called')
    // Wait for a timeout initiated flush to complete
    await prom
    // Queue is not empty
    if (queue.length) {
      // Wait for the throughput to drop below thresholds for items/sec
      // and bytes/sec limiters.
      await Promise.all([
        itemsLimiter.start(queue.length),
        bytesLimiter.start(bytes),
      ])
      // Call fn with queue
      const result = await fn(queue)
      debug('fn called')
      obj.lastResult = result
      // Reset the queue
      queue = []
      // Reset the size
      bytes = 0
      debug('queue reset')
    }
  }

  /**
   * Enqueue an item. If the batch size is reached wait
   * for queue to be flushed.
   */
  const enqueue = async (item: A) => {
    debug('enqueue called')
    // Wait for a timeout initiated flush to complete
    await prom
    // Start a timer if timeout is set and the queue is empty
    if (timeout && queue.length === 0) {
      timeoutId = setTimeout(() => {
        debug('setTimeout cb')
        prom = flush()
      }, timeout)
      debug('setTimeout called')
    }
    // Add item to queue
    queue.push(item)
    // Calculate total bytes
    if (options.batchBytes || maxBytesPerSec < Infinity) {
      bytes += size(item)
      debug('bytes %d', bytes)
    }
    // Batch size reached
    if (queue.length === batchSize) {
      debug('batchSize reached %d', queue.length)
      // Wait for queue to be flushed
      await flush()
    }
    // Batch bytes reached
    else if (options.batchBytes && bytes >= options.batchBytes) {
      debug('batchBytes reached %d', bytes)
      // Wait for queue to be flushed
      await flush()
    }
  }

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
  // eslint-disable-next-line
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
    debug('interval cleared')
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
        debug('timeout')
        clearTimeout(checkTimer)
        reject(new TimeoutError(`Did not complete in ${timeout} ms`))
      }, timeout)
    }

    /**
     * Check the predicate for truthiness.
     */
    const check = async () => {
      debug('check called')
      try {
        if (await pred()) {
          debug('pred returned truthy')
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
      debug('checkLater called')
      checkTimer = setTimeout(check, checkFrequency)
    }
    check()
  })

/**
 * Sleep for `time` ms before resolving the Promise.
 */
export const sleep = (time = 0) =>
  new Promise((resolve) => setTimeout(resolve, time))
