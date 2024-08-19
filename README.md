# prom-utils

Promise utilities designed for looping.

## rateLimit

Limit the concurrency of promises. This can be used to control
how many requests are made to a server, for example. Note:
exceptions will be swallowed in order to prevent an UnhandledPromiseRejection
from being thrown in the case where the promise rejects before the limit is
reached. Therefore, you must handle exceptions on a per promise basis.
Wrapping `rateLimit` method calls in a try/catch will not work.

```typescript
// Limit concurrency to at most 3
const limiter = rateLimit(3)

for (const url of urls) {
    // Will wait for one promise to finish if limit is reached
    await limiter.add(fetch(url))
}
// Wait for unresolved promises to resolve
await limiter.finish()
```

## batchQueue

Batch calls via a local queue. This can be used to batch values before
writing to a database, for example.

Calls `fn` when either `batchSize`, `batchBytes`, or `timeout` is reached.
`batchSize` defaults to 500 and therefore will always be in effect if
no options are provided. You can pass `Infinity` to disregard `batchSize`.
If `timeout` is passed, the timer will be started when the first item is
enqueued and reset when `flush` is called explicitly or implicitly.

Use `maxItemsPerSec` and/or `maxBytesPerSec` to limit throughput.
Call `queue.getStats()` to get the items/sec and bytes/sec rates.

Call `queue.flush()` to flush explicitly.

The last result of calling `fn` can be obtained by referencing `lastResult`
on the returned object.

```typescript
const writeToDatabase = async (records) => {...}

const queue = batchQueue(writeToDatabase)
for (const record of records) {
  // Will call `fn` when a threshold is met
  await queue.enqueue(record)
}
// Call `fn` with remaining queued items
await queue.flush()
```

**Types**

```typescript
export type QueueResult<A, B> = {
    /** Call `fn` with the items in the queue. */
    flush(): Promise<void>
    /** Add an item to the queue. When a queue condition is met `flush` will be called. */
    enqueue(item: A): Promise<void>
    /** The last result returned from calling `fn`. */
    lastResult?: Awaited<B>
    /** Get the current throughput rates. */
    getStats(): QueueStats
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

## throughputLimiter

Limit throughput by sleeping until the rate (units/sec)
is less than or equal to `maxUnitsPerSec`. Units is intentionally
abstract since it could represent records/sec or bytes/sec, for
example.

**Example**

```typescript
// Limit to at most 1000 items/sec
const limiter = throughputLimiter(1000)

for (const batch of batches) {
    // Will wait until the rate is <= `maxUnitsPerSec`
    await limiter.throttle(batch.length)
    console.log('Items/sec %d', limiter.getCurrentRate())
}
```

**Types**

```typescript
export interface ThroughputLimiterOptions {
    /** The maximum number of start invocations to hold in memory. */
    windowLength?: number
    /** Number of ms to sleep before checking the rate again. Defaults to 100. */
    sleepTime?: number
}
```

## pausable

Pause a loop by awaiting `maybeBlock`. When `pause` is called `maybeBlock` will
return a promise that is resolved when `resume` is called. Otherwise,
`maybeBlock` will return immediately. If `timeout` is passed, `resume` will
be called after `timeout` if it is not manually called first.

```typescript
const shouldProcess = pausable()

onSomeCondition(shouldProcess.pause)
onSomeOtherCondition(shouldProcess.resume)

for (const record of records) {
    await shouldProcess.maybeBlock()
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

## sleep

Sleep for `time` ms before resolving the Promise.

```typescript
// Sleep for one second
await sleep(1000)
```

## pacemaker

Call heartbeatFn every interval until promise resolves or rejects.
`interval` defaults to 1000.

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

## raceTimeout

Returns the value of the promise if the promise resolves prior to timeout.
If the timeout happens first, the exported TIMEOUT symbol is returned.

```typescript
const winner = await raceTimeout(someProm, 5)

if (winner === TIMEOUT) {
  // Do something
}
```
