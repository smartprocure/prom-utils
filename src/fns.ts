import _debug from 'debug'
import { clamp, shuffle, sumBy } from 'lodash'
import makeError from 'make-error'
import { size } from 'obj-walker'

import {
  AddOptions,
  AsyncIter,
  Deferred,
  GetTimeframe,
  IteratorFailure,
  IteratorSuccess,
  QueueOptions,
  QueueOptionsParallel,
  QueueResult,
  QueueResultParallel,
  RateLimitOptions,
  SlidingWindow,
  ThroughputLimiterOptions,
  WaitOptions,
} from './types'

const debugRL = _debug('prom-utils:rateLimit')
const debugTL = _debug('prom-utils:throughputLimiter')
const debugBQ = _debug('prom-utils:batchQueue')
const debugBQP = _debug('prom-utils:batchQueueParallel')
const debugPM = _debug('prom-utils:pacemaker')
const debugWU = _debug('prom-utils:waitUntil')
const debugP = _debug('prom-utils:pausable')

// Error classes
export const OptionsError = makeError('OptionsError')
export const TimeoutError = makeError('TimeoutError')

/**
 * Limit the concurrency of promises. This can be used to control
 * how many requests are made to a server, for example. Note:
 * exceptions will be swallowed in order to prevent an UnhandledPromiseRejection
 * from being thrown in the case where the promise rejects before the limit is
 * reached. Therefore, you must handle exceptions on a per promise basis.
 * Wrapping `rateLimit` method calls in a try/catch will not work. You can
 * set `limit` to Infinity to disregard the limit.
 *
 * To limit the promises for a given period of time, use the `maxItemsPerPeriod`
 * option. Optionally, specify a time period using the `period` option (default is 1 second).
 * For example, the following limits the number of concurrent requests to 5
 * and ensures that the rate never exceeds 75 requests per minute.
 *
 * @example
 * ```typescript
 * const limiter = rateLimit(5, { maxItemsPerPeriod: 75, period: ms('1m') })
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
  options: RateLimitOptions & ThroughputLimiterOptions = {}
) => {
  const { maxItemsPerPeriod } = options
  debugRL('init - limit %d', limit)
  debugRL('init - maxItemsPerPeriod %d', maxItemsPerPeriod)
  // Set of promises
  const set = new Set<Promise<T>>()
  // Default period to 1 second
  const period = options.period || 1000
  // Items/period limiter
  const itemsLimiter = throughputLimiter(maxItemsPerPeriod ?? Infinity, {
    // Allow for high throughput at the start of the period
    getTimeframe: getTimeframeUsingPeriod,
    // Expire items after the period
    expireAfter: period,
    period,
    // Ensure that the sliding window accurately captures all items for the period
    maxWindowLength: maxItemsPerPeriod,
    ...options,
  })
  /**
   * Add a promise. Waits for one promise to resolve if limit is met or for
   * throughput to drop below threshold if `maxItemsPerPeriod` is set.
   * Optionally, set `bypass` to true to bypass async waiting.
   */
  const add = async (prom: Promise<T>, options: AddOptions = {}) => {
    // Add to set
    set.add(prom)
    debugRL('add called. set size: %d', set.size)
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

    // Bypass async waiting
    if (options.bypass) {
      return
    }
    // Apply throughput limiter
    if (maxItemsPerPeriod) {
      // Wait for the throughput to drop below threshold for items/period
      await itemsLimiter.appendAndThrottle(1)
    }
    // Limit was reached
    if (set.size === limit) {
      debugRL('limit reached: %d', limit)
      // Wait for one item to finish
      await Promise.race(set)
    }
  }
  /**
   * items/period
   */
  const getStats = () => ({
    itemsPerPeriod: itemsLimiter.getCurrentRate(),
  })
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
    getStats,
  }
}

/**
 * Return the elapsed time since the first entry in the sliding window.
 * This evenly distributes the rate over the period.
 */
export const getTimeframeUsingElapsed: GetTimeframe = (slidingWindow) => {
  const { timestamp } = slidingWindow[0]
  return new Date().getTime() - timestamp
}

/**
 * Return the elapsed time since the first entry in the sliding window or the period,
 * whichever is greater. This allows for high throughput at the start of the period.
 */
export const getTimeframeUsingPeriod: GetTimeframe = (
  slidingWindow,
  { period }
) => {
  const { timestamp } = slidingWindow[0]
  const elapsedSinceStartOfWindow = new Date().getTime() - timestamp
  return Math.max(period, elapsedSinceStartOfWindow)
}

const getTLDefaults = (
  maxUnitsPerPeriod: number,
  options: ThroughputLimiterOptions
) => {
  const _options = {
    period: 1000,
    minWindowLength: 1,
    expireAfter: Infinity,
    getTimeframe: getTimeframeUsingElapsed,
    ...options,
  }
  const minWindowLength = _options.minWindowLength
  const _maxWindowLength = options.maxWindowLength || 3
  // Ensure that maxWindowLength is at least minWindowLength
  const maxWindowLength =
    _maxWindowLength < minWindowLength ? minWindowLength : _maxWindowLength
  return {
    ..._options,
    maxWindowLength,
    // Ensure the sleep time is granular enough but between 1 and 500 ms
    sleepTime: clamp(_options.period / maxUnitsPerPeriod, 1, 500),
  }
}

/**
 *
 * Limit throughput by sleeping until the rate (units/period)
 * is less than `maxUnitsPerPeriod`. Units and period are
 * intentionally abstract since it could represent requests/min or bytes/sec,
 * for example.
 *
 * @example
 * ```typescript
 * // Limit to at most 1000 items/sec
 * const limiter = throughputLimiter(1000)
 *
 * for(const batch of batches) {
 *   // Will wait until the rate is < `maxUnitsPerPeriod`
 *   await limiter.throttleAndAppend(batch.length)
 *   console.log('Items/sec %d', limiter.getCurrentRate())
 * }
 * ```
 */
export const throughputLimiter = (
  maxUnitsPerPeriod: number,
  options: ThroughputLimiterOptions = {}
) => {
  const slidingWindow: SlidingWindow = []
  const optionsWithDefaults = getTLDefaults(maxUnitsPerPeriod, options)
  const {
    period,
    minWindowLength,
    maxWindowLength,
    sleepTime,
    expireAfter,
    getTimeframe,
  } = optionsWithDefaults
  debugTL('init - maxUnitsPerPeriod %d', maxUnitsPerPeriod)
  debugTL('init - period %d ms', period)
  debugTL('init - minWindowLength %d', minWindowLength)
  debugTL('init - maxWindowLength %d', maxWindowLength)
  debugTL('init - sleepTime %d ms', sleepTime)
  debugTL('init - expireAfter %d ms', expireAfter)

  if (maxWindowLength === Infinity && expireAfter === Infinity) {
    throw new OptionsError(
      'maxWindowLength and expireAfter cannot both be Infinity'
    )
  }

  /**
   * Remove expired invocations from the sliding window.
   */
  const cleanupExpired = () => {
    debugTL('cleanupExpired called')
    // Remove expired invocations
    if (expireAfter !== Infinity) {
      // Get the current time
      const now = new Date().getTime()
      // Remove invocations that are older than expireAfter
      while (now - slidingWindow[0]?.timestamp > expireAfter) {
        const shifted = slidingWindow.shift()
        debugTL('removed expired: %o', shifted)
      }
    }
  }

  /**
   * Get the current rate (units/period). The rate is determined by averaging the
   * values in the sliding window where the elapsed time is determined by
   * comparing the first entry in the window to the current time.
   *
   * @returns The current rate (units/period). Rate will be zero if the window
   * length is less than `minWindowLength`.
   */
  const getCurrentRate = () => {
    debugTL('getCurrentRate called')
    // Remove expired invocations
    cleanupExpired()
    // Calculate the rate
    if (slidingWindow.length >= minWindowLength) {
      const numUnits = sumBy(slidingWindow, 'numUnits')
      const timeframe = getTimeframe(slidingWindow, optionsWithDefaults)
      debugTL('total units %d', numUnits)
      debugTL('timeframe %d ms', timeframe)
      const rate = numUnits / (timeframe / period)
      debugTL('current rate %d units/period', rate)
      return rate
    }
    debugTL('current rate 0')
    return 0
  }

  /**
   * Call before processing a batch of units. After the first call, a subsequent
   * call assumes that the `numUnits` from the previous call were processed. A
   * call to `throttle` may sleep for a given period of time depending on
   * `maxUnitsPerPeriod` and the total number of units over the current window.
   */
  const throttle = async () => {
    debugTL('throttle called')
    // Skip check if maxUnitsPerPeriod is Infinity
    if (maxUnitsPerPeriod === Infinity) {
      debugTL('exiting throttle - maxUnitsPerPeriod is Infinity')
      return
    }
    let throttleTime = 0
    // Check the rate, sleep, and repeat until the rate is less than
    // maxUnitsPerPeriod
    while (getCurrentRate() >= maxUnitsPerPeriod) {
      debugTL('sleeping for %d ms', sleepTime)
      await sleep(sleepTime)
      throttleTime += sleepTime
    }
    debugTL('throttled for %d ms', throttleTime)
  }

  /**
   * Append the number of units to the sliding window. Throttle
   * must be called separately to ensure that the rate stays below
   * `maxUnitsPerPeriod`.
   */
  const append = (numUnits: number) => {
    debugTL('append called with %d unit(s)', numUnits)
    // Get the current time
    const now = new Date().getTime()
    // Add the current invocation to the sliding window
    slidingWindow.push({ timestamp: now, numUnits })
    // Truncate the sliding window according to the window length
    if (slidingWindow.length > maxWindowLength) {
      const shifted = slidingWindow.shift()
      debugTL('removed due to length: %o', shifted)
    }
    debugTL('slidingWindow: %o', slidingWindow)
  }

  /**
   * This method is a combination of `throttle` and `append`. It will throttle
   * first and then append the number of units to the sliding window.
   */
  const throttleAndAppend = async (numUnits: number) => {
    await throttle()
    append(numUnits)
  }

  /**
   * This method is a combination of `append` and `throttle`. It will append
   * the number of units to the sliding window and then throttle.
   */
  const appendAndThrottle = async (numUnits: number) => {
    append(numUnits)
    await throttle()
  }

  return {
    getCurrentRate,
    throttle,
    append,
    throttleAndAppend,
    appendAndThrottle,
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
      await Promise.all([itemsLimiter.throttle(), bytesLimiter.throttle()])
      // Call fn with queue
      const result = await fn(queue)
      debugBQ('fn called')
      // Append the number of items and bytes to the limiters
      itemsLimiter.append(queue.length)
      bytesLimiter.append(bytes)
      // Set the last result
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
   * Get stats for the two limiters. These will be zero if the
   * corresponding option is not enabled.
   * @returns The current items/sec and bytes/sec values.
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
 * Batch calls via a local queue. This can be used to batch values before
 * writing to a database, for example. Unlike `batchQueue`, this is safe to
 * be called concurrently. In particular, you can pair `rateLimit` with this.
 *
 * Calls `fn` when either `batchSize` or `batchBytes` is reached.
 * `batchSize` defaults to 500 and therefore will always be in effect if
 * no options are provided. You can pass `Infinity` to disregard `batchSize`.
 *
 * Call `queue.flush()` to flush explicitly.
 */
export function batchQueueParallel<A, B>(
  fn: (arr: A[]) => B,
  options: QueueOptionsParallel = {}
) {
  const { batchSize = 500, batchBytes } = options
  debugBQP('options %o', options)
  let queue: A[] = []
  let bytes = 0
  const results: B[] = []

  /**
   * Call fn on queue and clear the queue
   */
  const flush = () => {
    debugBQP('flush called - queue length %d', queue.length)
    // Queue is not empty
    if (queue.length) {
      // Call fn with queue
      results.push(fn(queue))
      debugBQP('fn called')
      // Reset the queue
      queue = []
      // Reset the size
      bytes = 0
      debugBQP('queue reset')
    }
  }

  /**
   * Enqueue an item. If a threshold is reached flush queue immediately.
   */
  const enqueue = (item: A) => {
    debugBQP('enqueue called')
    // Add item to queue
    queue.push(item)
    // Calculate total bytes if a bytes-related option is set
    if (batchBytes) {
      bytes += size(item)
      debugBQP('bytes %d', bytes)
    }
    // Batch size reached
    if (queue.length === batchSize) {
      debugBQP('batchSize reached %d', queue.length)
      obj.lastFlush = { batchSize }
      // Flush queue
      flush()
    }
    // Batch bytes reached
    else if (batchBytes && bytes >= batchBytes) {
      debugBQP('batchBytes reached %d', bytes)
      obj.lastFlush = { batchBytes }
      // Flush queue
      flush()
    }
  }

  const obj: QueueResultParallel<A, B> = {
    flush,
    enqueue,
    results,
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
 * @returns The value of the resolved promise.
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

/**
 * Wait until the predicate returns truthy or the timeout expires.
 * Will not hang like other implementations found on NPM.
 * Inspired by https://www.npmjs.com/package/async-wait-until
 * @returns A promise that resolves or rejects, accordingly.
 *
 * @example
 * ```typescript
 * let isTruthy = false
 * setTimeout(() => { isTruthy = true }, 250)
 * await waitUntil(() => isTruthy)
 * ```
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
 * Merges multiple async iterators into a single async iterator. The merged
 * iterator will yield values as they become available from the input iterators.
 * The order in which iterators are initially polled is randomized to prevent
 * consistently favoring the first iterator when multiple values are available
 * simultaneously. If any of the input iterators throws an error, the merged
 * iterator will throw an error. The merged iterator will terminate when all of
 * the input iterators have terminated.
 *
 * @param iters - the async iterators to merge
 */
export const multiplex = async function* <T>(
  ...iters: Array<AsyncIter<T>>
): AsyncIterableIterator<T> {
  // Convert to Async Iterators
  const iterators = iters.map((iter) =>
    Symbol.asyncIterator in iter
      ? (iter as AsyncIterable<T>)[Symbol.asyncIterator]()
      : iter
  )

  // Call next on all iterators in random order to avoid favoring the first iterator
  const pending = new Map(
    shuffle(iterators).map((iterator) => [
      iterator,
      iterator.next().then(
        (res): IteratorSuccess<T> => ({ res, iterator }),
        (err): IteratorFailure<T> => ({ err, iterator })
      ),
    ])
  )

  try {
    while (pending.size > 0) {
      // Wait for the first iterator to resolve
      const result = await Promise.race(pending.values())

      // If it errored, throw the error
      if ('err' in result) {
        pending.delete(result.iterator)
        throw result.err
      }

      // If it's done, remove it from the pending list
      if (result.res.done) {
        pending.delete(result.iterator)
      }
      // Otherwise, yield the value and add it back to the pending list
      else {
        yield result.res.value
        pending.set(
          result.iterator,
          result.iterator.next().then(
            (res): IteratorSuccess<T> => ({ res, iterator: result.iterator }),
            (err): IteratorFailure<T> => ({ err, iterator: result.iterator })
          )
        )
      }
    }
  } finally {
    // If we exit the loop, make sure to clean up any remaining iterators
    await Promise.all(
      [...pending.keys()].map((iterator) => iterator.return?.())
    )
  }
}

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
