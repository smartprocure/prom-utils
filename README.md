# prom-utils

Promise utilities designed for looping.

## rateLimit

Limit the concurrency of promises. This can be used to control
how many requests are made to a server, for example.

```typescript
// Limit concurrency to at most 3
const limiter = rateLimit(3)

for (const url of urls) {
    await limiter.add(fetch(url))
}
// Wait for unresolved promises to resolve
await limiter.finish()
```

## batchQueue

Batch calls via a local queue. This can be used to batch values before
writing to a database, for example.

Calls `fn` when either `batchSize`, `batchBytes`, or `timeout` is reached.
`batchSize` defaults to 500 and therefore will always be in affect if
no options are provided. You can pass `Infinity` to disregard `batchSize`.
If `timeout` is passed, the timer will be started when the first item is
enqueued and reset when `flush` is called explicitly or implicitly.

Call `queue.flush()` to flush explicitly.

The last result of calling `fn` can be obtained by referencing `lastResult`
on the returned object.

**Types**

```typescript
export type QueueResult<A, B> = {
    /** Call `fn` with the items in the queue. */
    flush(): Promise<void>
    /** Add an item to the queue. When a queue condition is met `flush` will be called. */
    enqueue(item: A): Promise<void>
    /** The last result returned from calling `fn`. */
    lastResult?: B
}

export interface QueueOptions {
    /** Wait for the batch to reach this number of elements before flushing the queue. */
    batchSize?: number
    /** Wait for the batch to reach this size in bytes before flushing the queue. */
    batchBytes?: number
    /** Wait this long in ms before flushing the queue. */
    timeout?: number
}
```

**Example**

```typescript
const writeToDatabase = async (records) => {...}
const batchSize = 250

const queue = batchQueue(writeToDatabase, { batchSize })
for (const record of records) {
  await queue.enqueue(record)
}
await queue.flush()
```

## pausable

Pause a loop by awaiting `proceed`. When `pause` is called `proceed` will
return a promise that is resolved when `resume` is called. Otherwise,
`proceed` will return immediately. If `timeout` is passed, `resume` will
be called after `timeout` if it is not manually called first.

```typescript
const shouldProcess = pausable()

onSomeCondition(shouldProcess.pause)
onSomeOtherCondition(shouldProcess.resume)

for (const record of records) {
    await shouldProcess.proceed()
    await processRecord(record)
}
```

## defer

Defer resolving a promise until `done` is called.

```typescript
const delay = (milliseconds: number) => {
    const deferred = defer()
    setTimeout(deferred.done, milliseconds, '🦄')
    return deferred.promise
}
```

## pacemaker

Call heartbeatFn every interval until promise resolves or rejects.
Returns the value of the resolved promise.

```typescript
const heartbeatFn = () => {
    // Emit heartbeat
}

const result = await pacemaker(heartbeatFn, someProm)
```

## waitUntil

Wait until the predicate returns truthy or the timeout expires.
Returns a promise.

**Types**

```typescript
export interface WaitOptions {
    /** Wait this long in ms before rejecting. Defaults to 5000 ms. */
    timeout?: number
    /** Check the predicate with this frequency. Defaults to 50 ms. */
    checkFrequency?: number
}
```

**Example**

```typescript
let isTruthy = false
setTimeout(() => {
    isTruthy = true
}, 250)
await waitUntil(() => isTruthy)
```
