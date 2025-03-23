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

export interface RateLimitOptions {
  /**
   * Maximum throughput allowed (items/period). Defaults to items/sec.
   */
  maxItemsPerPeriod?: number
}

export interface QueueOptions {
  /** Wait for the batch to reach this number of elements before flushing the queue. */
  batchSize?: number
  /** Wait for the batch to reach this size in bytes before flushing the queue. */
  batchBytes?: number
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
   * The timeframe to use for calculating the rate.
   */
  getTimeframe?: GetTimeframe
}
