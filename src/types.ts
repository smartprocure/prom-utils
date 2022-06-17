export type QueueResult = {
  flush(): Promise<any>
  enqueue(item: any): Promise<void>
  lastResult?: any
}

export type Queue = (fn: (arr: any[]) => any, batchSize?: number) => QueueResult
