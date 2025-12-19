export type LastFlush =
  | { timeout: number }
  | { batchSize: number }
  | { batchBytes: number }

export interface QueueStats {
  itemsPerSec: number
  bytesPerSec: number
}

export type QueueResult<A, B> = {
  /** Call `fn` with the items in the queue. */
  flush(): Promise<void>
  /** Add an item to the queue. When a queue condition is met `flush` will be called. */
  enqueue(item: A): Promise<void>
  /** The last result returned from calling `fn`. */
  lastResult?: Awaited<B>
  /**
   * The cause for the last automatic queue flush. Will be one of the
   * following: timeout, batchSize, or batchBytes.
   */
  lastFlush?: LastFlush
  /** Get the current throughput rates. */
  getStats(): QueueStats
  /** Length of the queue. */
  get length(): number
}

export type QueueResultParallel<A, B> = {
  /** Call `fn` with the items in the queue. */
  flush(): void
  /** Add an item to the queue. When a queue condition is met `flush` will be called. */
  enqueue(item: A): void
  /** Array of accumulated results for all callback calls. */
  results: B[]
  /**
   * The cause for the last automatic queue flush. Will be one of the
   * following: batchSize or batchBytes.
   */
  lastFlush?: LastFlush
  /** Length of the queue. */
  get length(): number
}

/**
 * A simplified abstraction of a throughput limiter.
 *
 * Extends {@link ThroughputLimiterOptions}
 *
 * @remarks
 * The following defaults are applied when passed to `rateLimit`:
 * - `period`: 1000 ms (1 second)
 * - `getTimeframe`: `getTimeframeUsingPeriod` (allows high throughput at start of period)
 * - `expireAfter`: Same as `period`
 * - `maxWindowLength`: Same as `maxItemsPerPeriod`
 */
export interface RateLimiter extends ThroughputLimiterOptions {
  /**
   * Maximum throughput allowed (items/period)
   */
  maxItemsPerPeriod: number
}

export interface AddOptions {
  /**
   * Bypass async waiting. This is useful when the item being added is the
   * last item and you are limiting throughput.
   */
  bypass?: boolean
}

export interface QueueOptionsParallel {
  /**
   * Wait for the batch to reach this number of elements before flushing the queue.
   * Defaults to 500
   */
  batchSize?: number
  /** Wait for the batch to reach this size in bytes before flushing the queue. */
  batchBytes?: number
}

export interface QueueOptions extends QueueOptionsParallel {
  /** Wait this long in ms before flushing the queue. */
  timeout?: number
  /** Maximum throughput allowed (item/sec). */
  maxItemsPerSec?: number
  /** Maximum throughput allowed (bytes/sec). */
  maxBytesPerSec?: number
}

export interface Deferred {
  /** Resolve the promise. */
  done: () => void
  /** Resolves when `done` is called. */
  promise: Promise<void>
}

export interface WaitOptions {
  /** Wait this long in ms before rejecting. Defaults to 5000 ms. */
  timeout?: number
  /** Check the predicate with this frequency. Defaults to 50 ms. */
  checkFrequency?: number
}

export type SlidingWindow = { timestamp: number; numUnits: number }[]

export type GetTimeframe = (
  slidingWindow: SlidingWindow,
  options: Required<ThroughputLimiterOptions>
) => number

export interface ThroughputLimiterOptions {
  /**
   * The period of time in ms to track the rate. Set to 60_000 for 1 minute.
   * Defaults to 1000, which is units/sec.
   */
  period?: number
  /**
   * The minimum number of throttle invocations prior to checking the rate.
   * Use this to allow for short bursts without throttling.
   * Should be 1 or more. Defaults to 1.
   */
  minWindowLength?: number
  /**
   * The maximum number of throttle invocations to hold in memory.
   * Should be 1 or more. Defaults to 3.
   */
  maxWindowLength?: number
  /**
   * Expire throttle invocations after this many ms.
   * Defaults to Infinity.
   */
  expireAfter?: number
  /**
   * The timeframe to use for calculating the rate. There are two functions
   * provided: `getTimeframeUsingElapsed` and `getTimeframeUsingPeriod`.
   * The default is `getTimeframeUsingElapsed`.
   */
  getTimeframe?: GetTimeframe
}

export type AsyncIter<T> = AsyncIterator<T> | AsyncIterable<T>

export type IteratorSuccess<T> = {
  res: IteratorResult<T>
  iterator: AsyncIterator<T>
}
export type IteratorFailure<T> = { err: unknown; iterator: AsyncIterator<T> }
