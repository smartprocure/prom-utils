import sizeof from 'object-sizeof'
import _debug from 'debug'
import { Deferred, Queue, QueueResult } from './types'

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
export const rateLimit = (limit: number) => {
  debug('limit: %d', limit)
  const set = new Set<Promise<any>>()
  /**
   * Add a promise. Returns immediately if limit has not been
   * met. Waits for one promise to resolve if limit is met.
   */
  const add = async (prom: Promise<any>) => {
    // Add to set
    set.add(prom)
    debug('set size: %d', set.size)
    // Remove from set after resolving
    prom.then(
      () => {
        debug('delete')
        set.delete(prom)
      },
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
  const finish = () => {
    debug('finish')
    return Promise.all(set)
  }
  return { add, finish }
}

/**
 *
 * Batch calls via a local queue. This can be used to batch values before
 * writing to a database, for example.
 *
 * Automatically executes `fn` when `batchSize` is reached or `timeout` is
 * reached, if set. The timer will be started when the first item is
 * enqueued and reset when flush is called explicitly or implicitly.
 *
 * Call `queue.flush()` to flush explicitly.
 *
 * Batch size defaults to 500. The last result of calling `fn` can be
 * obtained by referencing `lastResult` on the returned object.
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
export const batchQueue: Queue = (fn, options = {}) => {
  const { batchSize = 500, timeout } = options
  debug('options %o', options)
  let queue: any[] = []
  let timeoutId: ReturnType<typeof setTimeout>
  let prom: Promise<any>
  let size = 0

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
      // Call fn with queue
      const result = await fn(queue)
      debug('fn called')
      obj.lastResult = result
      // Reset the queue
      queue = []
      // Reset the size
      size = 0
      debug('queue reset')
    }
  }

  /**
   * Enqueue an item. If the batch size is reached wait
   * for queue to be flushed.
   */
  const enqueue = async (item: any) => {
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
    // Batch size reached
    if (queue.length === batchSize) {
      debug('batchSize reached %d', queue.length)
      // Wait for queue to be flushed
      await flush()
    } else if (options.batchBytes) {
      // Determine size of object and add to sum
      size += sizeof(item)
      // Batch bytes reached
      if (size >= options.batchBytes) {
        debug('batchBytes reached %d', size)
        // Wait for queue to be flushed
        await flush()
      }
    }
  }

  const obj: QueueResult = { flush, enqueue }
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
