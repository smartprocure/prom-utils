import _debug from 'debug'
import { sumBy } from 'lodash'
import makeError from 'make-error'
import { size } from 'obj-walker'

import {
  Deferred,
  QueueOptions,
  QueueResult,
  RateLimitOptions,
  ThroughputLimiterOptions,
  WaitOptions,
} from './types'

const debugRL = _debug('prom-utils:rateLimit')
const debugTL = _debug('prom-utils:throughputLimiter')
const debugBQ = _debug('prom-utils:batchQueue')
const debugPM = _debug('prom-utils:pacemaker')
const debugWU = _debug('prom-utils:waitUntil')
const debugP = _debug('prom-utils:pausable')

/**
 * Limit the concurrency of promises. This can be used to control
 * how many requests are made to a server, for example. Note:
 * exceptions will be swallowed in order to prevent an UnhandledPromiseRejection
 * from being thrown in the case where the promise rejects before the limit is
 * reached. Therefore, you must handle exceptions on a per promise basis.
 * Wrapping `rateLimit` method calls in a try/catch will not work. You can
 * set `limit` to Infinity to disregard the limit.
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
export const rateLimit = <T = unknown>(
  limit: number,
  options: RateLimitOptions = {}
) => {
  debugRL('limit: %d', limit)
  const set = new Set<Promise<T>>()

  const { maxItemsPerSec = Infinity } = options
  const itemsLimiter = throughputLimiter(maxItemsPerSec)
  /**
   * Add a promise. Returns immediately if limit has not been
   * met. Waits for one promise to resolve if limit is met.
   */
  const add = async (prom: Promise<T>) => {
    // Add to set
    set.add(prom)
    debugRL('set size: %d', set.size)
    // Create a child promise
    // See: https://runkit.com/dubiousdavid/handling-promise-rejections
    prom.then(
      () => {
        debugRL('resolved')
        // Remove from the set
        set.delete(prom)
      },
      // Handle the exception so we don't throw an UnhandledPromiseRejection exception
      () => {
        debugRL('rejected')
        // Remove from the set
        set.delete(prom)
      }
    )
    if (maxItemsPerSec) {
      // Wait for the throughput to drop below thresholds for items/sec
      await itemsLimiter.throttle(1)
    }
    // Limit was reached
    if (set.size === limit) {
      debugRL('limit reached: %d', limit)
      // Wait for one item to finish
      await Promise.race(set)
    }
  }
  /**
   * Wait for all promises to resolve
   */
  const finish = async () => {
    debugRL('finish')
    await Promise.allSettled(set)
  }
  return {
    add,
    finish,
    /** Number of pending promises. */
    get length() {
      return set.size
    },
  }
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
  const slidingWindow: { timestamp: number; numUnits: number }[] = []
  const windowLength = options.windowLength || 3
  const sleepTime = options.sleepTime || 100
  debugTL('init - maxUnitsPerSec %d', maxUnitsPerSec)
  debugTL('init - windowLength %d', windowLength)
  debugTL('init - sleepTime %d', sleepTime)

  /**
   * Get the current rate (units/sec). The rate is determined by averaging the
   * values in the sliding window where the elapsed time is determined by
   * comparing the first entry in the window to the current time. Returns 0
   * if `throttle` has not been called.
   */
  const getCurrentRate = () => {
    debugTL('getCurrentRate called')
    if (slidingWindow.length > 0) {
      const { timestamp } = slidingWindow[0]
      const numUnits = sumBy(slidingWindow, 'numUnits')
      debugTL('total units %d', numUnits)
      const rate = numUnits / ((new Date().getTime() - timestamp) / 1000)
      debugTL('current rate %d', rate)
      return rate
    }
    debugTL('current rate 0')
    return 0
  }

  /**
   * Call before processing a batch of units. After the first call, a subsequent
   * call assumes that the `numUnits` from the previous call were processed. A
   * call to `throttle` may sleep for a given period of time depending on
   * `maxUnitsPerSec` and the total number of units over the current window.
   */
  const throttle = async (numUnits: number) => {
    debugTL('throttle called - %d', numUnits)
    // Skip check if maxUnitsPerSec is Infinity
    if (maxUnitsPerSec === Infinity) {
      debugTL('exiting throttle - maxUnitsPerSec is Infinity')
      return
    }
    // Sleep if the current rate is above the max allowed. Repeat
    // until the rate has dropped sufficiently.
    while (getCurrentRate() > maxUnitsPerSec) {
      debugTL('sleeping for %d', sleepTime)
      await sleep(sleepTime)
    }
    slidingWindow.push({ timestamp: new Date().getTime(), numUnits })
    if (slidingWindow.length > windowLength) {
      debugTL('truncating slidingWindow')
      slidingWindow.shift()
    }
    debugTL('slidingWindow %o', slidingWindow)
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
 * The cause of the last automatic queue flush can be obtained by referencing
 * `lastFlush` on the returned object.
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
    batchBytes,
    timeout,
    maxItemsPerSec = Infinity,
    maxBytesPerSec = Infinity,
  } = options
  debugBQ('options %o', options)
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
    debugBQ('flush called - queue length %d', queue.length)
    // Clear the timeout
    clearTimeout(timeoutId)
    debugBQ('clearTimeout called')
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
      debugBQ('fn called')
      obj.lastResult = result
      // Reset the queue
      queue = []
      // Reset the size
      bytes = 0
      debugBQ('queue reset')
    }
  }

  /**
   * Enqueue an item. If the batch size is reached wait
   * for queue to be flushed.
   */
  const enqueue = async (item: A) => {
    debugBQ('enqueue called')
    // Wait for a timeout initiated flush to complete
    await prom
    // Start a timer if timeout is set and the queue is empty
    if (timeout && queue.length === 0) {
      timeoutId = setTimeout(() => {
        debugBQ('setTimeout cb')
        obj.lastFlush = { timeout }
        prom = flush()
      }, timeout)
      debugBQ('setTimeout called')
    }
    // Add item to queue
    queue.push(item)
    // Calculate total bytes if a bytes-related option is set
    if (batchBytes || maxBytesPerSec < Infinity) {
      bytes += size(item)
      debugBQ('bytes %d', bytes)
    }
    // Batch size reached
    if (queue.length === batchSize) {
      debugBQ('batchSize reached %d', queue.length)
      obj.lastFlush = { batchSize }
      // Wait for queue to be flushed
      await flush()
    }
    // Batch bytes reached
    else if (batchBytes && bytes >= batchBytes) {
      debugBQ('batchBytes reached %d', bytes)
      obj.lastFlush = { batchBytes }
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

  const obj: QueueResult<A, B> = {
    flush,
    enqueue,
    getStats,
    get length() {
      return queue.length
    },
  }
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
 * Pause a loop by awaiting `maybeBlock`. When `pause` is called `maybeBlock` will
 * return a promise that is resolved when `resume` is called. Otherwise,
 * `maybeBlock` will return immediately. If `timeout` is passed, `resume` will
 * be called after `timeout` if it is not manually called first.
 *
 * ```typescript
 * const shouldProcess = pausable()
 *
 * onSomeCondition(shouldProcess.pause)
 * onSomeOtherCondition(shouldProcess.resume)
 *
 * for (const record of records) {
 *   await shouldProcess.maybeBlock()
 *   await processRecord(record)
 * }
 * ```
 */
export const pausable = (timeout?: number) => {
  let deferred: Deferred | undefined
  let timeoutId: ReturnType<typeof setTimeout>
  let isPaused = false
  /**
   * Change the state to pause. If timeout is passed, that will change
   * the state to resume for each call to pause after the specified timeout.
   */
  const pause = () => {
    debugP('pause called')
    deferred = defer()
    if (timeout) {
      timeoutId = setTimeout(() => {
        debugP('timeout')
        resume()
      }, timeout)
      debugP('setTimeout called')
    }
    isPaused = true
  }
  /**
   * Change the state to resume.
   */
  const resume = () => {
    debugP('resume called')
    if (timeout) {
      clearTimeout(timeoutId)
      debugP('timeout cleared')
    }
    deferred?.done()
    isPaused = false
  }
  /**
   * Should be awaited in a loop. Will block when in a pause state.
   */
  const maybeBlock = () => deferred?.promise

  return {
    pause,
    resume,
    maybeBlock,
    get isPaused() {
      return isPaused
    },
  }
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
    debugPM('interval cleared')
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
        debugWU('timeout')
        clearTimeout(checkTimer)
        reject(new TimeoutError(`Did not complete in ${timeout} ms`))
      }, timeout)
    }

    /**
     * Check the predicate for truthiness.
     */
    const check = async () => {
      debugWU('check called')
      try {
        if (await pred()) {
          debugWU('pred returned truthy')
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
      debugWU('checkLater called')
      checkTimer = setTimeout(check, checkFrequency)
    }
    check()
  })

/**
 * Sleep for `time` ms before resolving the Promise.
 */
export const sleep = (time = 0) =>
  new Promise((resolve) => setTimeout(resolve, time))

export const TIMEOUT = Symbol('TIMEOUT')

/**
 * Returns the value of the promise if the promise resolves prior to timeout.
 * If the timeout happens first, the exported TIMEOUT symbol is returned.
 *
 * @example
 * ```ts
 * const winner = await raceTimeout(someProm, 5)
 * if (winner === TIMEOUT) {
 *   // Do something
 * }
 * ```
 */
export const raceTimeout = <A>(prom: Promise<A>, timeout: number) =>
  Promise.race<A | typeof TIMEOUT>([
    prom,
    new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), timeout)),
  ])
