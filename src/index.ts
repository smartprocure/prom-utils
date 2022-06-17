import { Queue, QueueResult } from './types'

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
  const set = new Set<Promise<any>>()
  /**
   * Add a promise. Returns immediately if limit has not been
   * met. Waits for one promise to resolve if limit is met.
   */
  const add = async (prom: Promise<any>) => {
    // Add to set
    set.add(prom)
    // Remove from set after resolving
    prom.then(() => set.delete(prom))
    // Limit was reached
    if (set.size === limit) {
      // Wait for one item to finish
      await Promise.race(set)
    }
  }
  /**
   * Wait for all promises to resolve
   */
  const finish = () => Promise.all(set)
  return { add, finish }
}

/**
 * Batch calls via a local queue. Automatically executes `fn`
 * when `batchSize` is reached. Call `queue.flush()` to flush explicitly.
 * This can be used to batch values before writing to a database, for
 * example.
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
export const batchQueue: Queue = (fn, batchSize = 500) => {
  let queue: any[] = []

  /**
   * Returns result of calling fn on queue. Clears the queue.
   */
  const flush = async () => {
    if (queue.length) {
      // Call fn with queue
      const result = await fn(queue)
      obj.lastResult = result
      // Reset the queue
      queue = []
      return result
    }
  }

  /**
   * Enqueue an item. If the batch size is reached wait
   * for queue to flushed.
   */
  const enqueue = async (item: any) => {
    // Add item to queue
    queue.push(item)
    // Batch size reached
    if (queue.length === batchSize) {
      // Wait for queue to be flushed
      await flush()
    }
  }

  const obj: QueueResult = { flush, enqueue }
  return obj
}
