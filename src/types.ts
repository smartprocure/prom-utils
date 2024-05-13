export type QueueResult = {
  flush(): Promise<void>
  enqueue(item: any): Promise<void>
  lastResult?: any
}

export interface QueueOptions {
  /** Wait for the batch to reach this number of elements before flushing the queue. */
  batchSize?: number
  /** Wait for the batch to reach this size in bytes before flushing the queue. */
  batchBytes?: number
  /** Wait this long in ms before flushing the queue. */
  timeout?: number
}

export type Queue = (
  fn: (arr: any[]) => any,
  options?: QueueOptions
) => QueueResult

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
