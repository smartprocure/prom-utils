export type QueueResult<A,B> = {
  /** Call `fn` with the items in the queue. */
  flush(): Promise<void>
  /** Add an item to the queue. When a queue condition is met `flush` will be called. */
  enqueue(item: A): Promise<void>
  /** The last result returned from calling `fn`. */
  lastResult?: Awaited<B>
}

export interface QueueOptions {
  /** Wait for the batch to reach this number of elements before flushing the queue. */
  batchSize?: number
  /** Wait for the batch to reach this size in bytes before flushing the queue. */
  batchBytes?: number
  /** Wait this long in ms before flushing the queue. */
  timeout?: number
}

export interface Deferred {
  done: () => void
  promise: Promise<void>
}

export interface WaitOptions {
  /** Wait this long in ms before rejecting. Defaults to 5000 ms. */
  timeout?: number
  /** Check the predicate with this frequency. Defaults to 50 ms. */
  checkFrequency?: number
}
