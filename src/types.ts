export type QueueResult = {
  flush(): Promise<void>
  enqueue(item: any): Promise<void>
  lastResult?: any
}

export interface QueueOptions {
  batchSize?: number
  timeout?: number
}

export type Queue = (
  fn: (arr: any[]) => any,
  options?: QueueOptions
) => QueueResult
