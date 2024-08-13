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
  /** Get the current throughput rates. */
  getStats(): QueueStats
  /** Length of the queue. */
  get length(): number
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

export interface ThroughputLimiterOptions {
  /** The maximum number of throttle invocations to hold in memory. */
  windowLength?: number
  /** Number of ms to sleep before checking the rate again. Defaults to 100. */
  sleepTime?: number
}
