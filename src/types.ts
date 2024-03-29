export type QueueResult = {
  flush(): Promise<void>
  enqueue(item: any): Promise<void>
  lastResult?: any
}

export interface QueueOptions {
  batchSize?: number
  batchBytes?: number
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
