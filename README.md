# Prom-Utils

Promise utilities designed for handling asynchronous operations and controlling throughput in JavaScript/TypeScript applications.

## Table of Contents

- [Installation](#installation)
- [API Reference](#api-reference)
    - [rateLimit](#ratelimit)
    - [batchQueue](#batchqueue)
    - [batchQueueParallel](#batchqueueparallel)
    - [throughputLimiter](#throughputlimiter)
    - [pausable](#pausable)
    - [defer](#defer)
    - [sleep](#sleep)
    - [pacemaker](#pacemaker)
    - [waitUntil](#waituntil)
    - [raceTimeout](#racetimeout)
- [Error Handling](#error-handling)

## Installation

```bash
npm install prom-utils
```

## API Reference

### rateLimit

Limits the concurrency of promises. This can be used to control how many requests are made to a server or API at once.

**Note**: Exceptions will be swallowed internally to prevent UnhandledPromiseRejection errors when promises reject before the limit is reached. Handle exceptions on a per-promise basis.

#### Parameters

- `limit: number` - Maximum number of concurrent promises (set to `Infinity` to disable)
- `options: RateLimitOptions & ThroughputLimiterOptions` - Configuration options

#### Options

The `rateLimit` function accepts two types of options:

```typescript
interface RateLimitOptions {
    /**
     * Maximum throughput allowed (items/period). Defaults to items/sec.
     */
    maxItemsPerPeriod?: number
}
```

Since `rateLimit` internally uses `throughputLimiter`, it also accepts all options from `ThroughputLimiterOptions`.
Below are the options for `ThroughputLimiterOptions` with the defaults used for `rateLimit`.

```typescript
interface ThroughputLimiterOptions {
    /**
     * The period of time in ms to track the rate. Set to 60000 for 1 minute.
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
     * Should be 1 or more. Defaults to maxItemsPerPeriod.
     */
    maxWindowLength?: number
    /**
     * Expire throttle invocations after this many ms.
     * Defaults to the period.
     */
    expireAfter?: number
    /**
     * The timeframe to use for calculating the rate.
     * Defaults to getTimeframeUsingPeriod.
     */
    getTimeframe?: GetTimeframe
}
```

#### Returns

```typescript
{
    /**
     * Add a promise. Waits for one promise to resolve if limit is met or for
     * throughput to drop below threshold if `maxItemsPerPeriod` is set.
     * Optionally, set `bypass` to true to bypass async waiting.
     */
    add: (prom: Promise<T>, options?: AddOptions) => Promise<void>
    /**
     * Wait for all promises to resolve
     */
    finish: () => Promise<void>
    /**
     * Number of pending promises.
     */
    length: number
    /**
     * Get current rate statistics
     */
    getStats: () => {
        itemsPerPeriod: number
    }
}
```

#### Example

```typescript
const limiter = rateLimit(5, { maxItemsPerPeriod: 75, period: 60000 }) // 5 concurrent, max 75 per minute

for (const url of urls) {
    // Will wait for one promise to finish if limit is reached
    await limiter.add(fetch(url))
}
// Wait for unresolved promises to resolve
await limiter.finish()
```

### batchQueue

Batches calls via a local queue. This can be used to accumulate values before writing to a database or making API calls.

#### Parameters

- `fn: (arr: A[]) => B` - Function to call with batched items
- `options: QueueOptions` - Configuration options

#### Options

```typescript
interface QueueOptions {
    /**
     * Wait for the batch to reach this number of elements before flushing the queue.
     * Defaults to 500.
     */
    batchSize?: number
    /**
     * Wait for the batch to reach this size in bytes before flushing the queue.
     */
    batchBytes?: number
    /**
     * Wait this long in ms before flushing the queue.
     */
    timeout?: number
    /**
     * Maximum throughput allowed (items/sec).
     * Defaults to Infinity.
     */
    maxItemsPerSec?: number
    /**
     * Maximum throughput allowed (bytes/sec).
     * Defaults to Infinity.
     */
    maxBytesPerSec?: number
}
```

#### Returns

```typescript
{
  /**
   * Call fn with the items in the queue.
   */
  flush: () => Promise<void>
  /**
   * Add an item to the queue. When a queue condition is met flush will be called.
   */
  enqueue: (item: A) => Promise<void>
  /**
   * The last result returned from calling fn.
   */
  lastResult?: Awaited<B>
  /**
   * The cause for the last automatic queue flush. Will be one of:
   * timeout, batchSize, or batchBytes.
   */
  lastFlush?: LastFlush
  /**
   * Get the current throughput rates.
   */
  getStats: () => QueueStats
  /**
   * Length of the queue.
   */
  length: number
}
```

#### Example

```typescript
const writeToDatabase = async (records) => {
    // database write logic here
    return { success: true }
}

const queue = batchQueue(writeToDatabase, {
    batchSize: 250,
    timeout: 5000, // also flush after 5 seconds
    maxItemsPerSec: 1000, // limit to 1000 items per second
})

for (const record of records) {
    await queue.enqueue(record)
}

// Call fn with remaining queued items
await queue.flush()

// Check statistics
console.log(queue.getStats())
```

### batchQueueParallel

Batches calls via a local queue, similar to `batchQueue` but designed to be safe for concurrent access. This can be used to accumulate values before writing to a database or making API calls when you need to call it from multiple concurrent contexts.

**Note**: Unlike `batchQueue`, this function does not support timeout-based flushing or throughput limiting options. It only supports `batchSize` and `batchBytes` triggers.

#### Parameters

- `fn: (arr: A[]) => unknown` - Function to call with batched items
- `options: QueueOptionsParallel` - Configuration options

#### Options

```typescript
interface QueueOptionsParallel {
    /**
     * Wait for the batch to reach this number of elements before flushing the queue.
     * Defaults to 500.
     */
    batchSize?: number
    /**
     * Wait for the batch to reach this size in bytes before flushing the queue.
     */
    batchBytes?: number
}
```

#### Returns

```typescript
{
  /**
   * Call fn with the items in the queue.
   */
  flush: () => void
  /**
   * Add an item to the queue. When a queue condition is met flush will be called.
   */
  enqueue: (item: A) => void
  /**
   * Length of the queue.
   */
  length: number
}
```

#### Example

```typescript
const writeToDatabase = (records) => {
    // database write logic here
    console.log(`Writing ${records.length} records`)
}

const queue = batchQueueParallel(writeToDatabase, {
    batchSize: 250,
    batchBytes: 1024 * 1024, // 1MB
})

// Safe to call from multiple concurrent contexts
await Promise.all(
    records.map(async (record) => {
        // This is safe to call concurrently
        queue.enqueue(record)
    })
)

// Call fn with remaining queued items
queue.flush()
```

### throughputLimiter

Limits throughput by sleeping until the rate (units/period) is less than the maximum limit. Units and period are intentionally abstract since they could represent requests/min, bytes/sec, etc.

#### Parameters

- `maxUnitsPerPeriod: number` - Maximum units allowed per period
- `options: ThroughputLimiterOptions` - Configuration options

#### Options

```typescript
interface ThroughputLimiterOptions {
    /**
     * The period of time in ms to track the rate. Set to 60000 for 1 minute.
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
     * Two built-in options: getTimeframeUsingElapsed or getTimeframeUsingPeriod.
     * Defaults to getTimeframeUsingElapsed.
     */
    getTimeframe?: GetTimeframe
}
```

#### Returns

```typescript
{
  /**
   * Get the current rate (units/period).
   */
  getCurrentRate: () => number
  /**
   * Sleep until the rate is below the maximum.
   */
  throttle: () => Promise<void>
  /**
   * Add units to the sliding window.
   */
  append: (numUnits: number) => void
  /**
   * Throttle first, then append.
   */
  throttleAndAppend: (numUnits: number) => Promise<void>
  /**
   * Append first, then throttle.
   */
  appendAndThrottle: (numUnits: number) => Promise<void>
}
```

#### Example

```typescript
// Limit to at most 1000 items/sec
const limiter = throughputLimiter(1000)

for (const batch of batches) {
    // Will wait until the rate is < maxUnitsPerPeriod
    await limiter.throttleAndAppend(batch.length)
    console.log('Current rate: %d items/sec', limiter.getCurrentRate())
}
```

### pausable

Creates a mechanism to pause and resume a loop. When `pause` is called, `maybeBlock` will return a promise that resolves when `resume` is called.

#### Parameters

- `timeout?: number` - Optional timeout in ms to auto-resume

#### Returns

```typescript
{
  /**
   * Pause execution when maybeBlock is called.
   */
  pause: () => void
  /**
   * Resume execution.
   */
  resume: () => void
  /**
   * Call in your loop to potentially block execution.
   */
  maybeBlock: () => Promise<void> | undefined
  /**
   * Whether currently paused.
   */
  isPaused: boolean
}
```

#### Example

```typescript
const shouldProcess = pausable()

// In some event handler or condition
onSomeCondition(() => shouldProcess.pause())
onSomeOtherCondition(() => shouldProcess.resume())

// In your processing loop
for (const record of records) {
    await shouldProcess.maybeBlock()
    await processRecord(record)
}
```

### defer

Creates a deferred promise that resolves when `done` is called.

#### Returns

```typescript
{
  /**
   * Resolves the promise when called.
   */
  done: () => void
  /**
   * Promise that resolves when done() is called.
   */
  promise: Promise<void>
}
```

#### Example

```typescript
const delay = (milliseconds: number) => {
    const deferred = defer()
    setTimeout(deferred.done, milliseconds)
    return deferred.promise
}

// Use the delay function
await delay(1000) // Wait 1 second
```

### sleep

Sleep for a specified time before resolving the promise.

#### Parameters

- `time?: number` - Time to sleep in ms, defaults to 0

#### Returns

- `Promise<void>` - Resolves after the specified time

#### Example

```typescript
// Sleep for one second
await sleep(1000)
```

### pacemaker

Calls a heartbeat function at regular intervals until a promise resolves or rejects.

#### Parameters

- `heartbeatFn: () => void` - Function to call at intervals
- `promise: Promise<T>` - Promise to wait for
- `interval?: number` - Interval in ms, defaults to 1000

#### Returns

- The value from the resolved promise

#### Example

```typescript
const heartbeatFn = () => {
    console.log('Still processing...')
}

const result = await pacemaker(heartbeatFn, longRunningOperation())
```

### waitUntil

Waits until a predicate function returns true or a timeout expires.

#### Parameters

- `pred: () => Promise<boolean> | boolean` - Predicate function
- `options: WaitOptions` - Configuration options

#### Options

```typescript
interface WaitOptions {
    /**
     * Wait this long in ms before rejecting. Defaults to 5000 ms.
     */
    timeout?: number
    /**
     * Check the predicate with this frequency. Defaults to 50 ms.
     */
    checkFrequency?: number
}
```

#### Returns

- `Promise<void>` - Resolves when the predicate returns true, rejects if timeout expires

#### Example

```typescript
let isReady = false
setTimeout(() => {
    isReady = true
}, 2000)

try {
    await waitUntil(() => isReady, { timeout: 5000 })
    console.log('Ready!')
} catch (error) {
    if (error instanceof TimeoutError) {
        console.log('Timed out waiting for ready state')
    } else {
        throw error
    }
}
```

### raceTimeout

Returns the value of a promise if it resolves before a timeout, otherwise returns the exported TIMEOUT symbol.

#### Parameters

- `prom: Promise<A>` - Promise to race
- `timeout: number` - Timeout in ms

#### Returns

- `Promise<A | typeof TIMEOUT>` - Either the promise result or TIMEOUT symbol

#### Example

```typescript
const winner = await raceTimeout(someLongOperation(), 5000)

if (winner === TIMEOUT) {
    console.log('Operation timed out')
} else {
    console.log('Operation completed with result:', winner)
}
```

## Error Handling

The library exports two error classes:

- `OptionsError` - Thrown when invalid options are provided
- `TimeoutError` - Thrown when an operation times out

Example:

```typescript
import { TimeoutError, waitUntil } from 'prom-utils'

try {
    await waitUntil(() => false, { timeout: 100 })
} catch (error) {
    if (error instanceof TimeoutError) {
        console.log('Timed out:', error.message)
    } else {
        throw error
    }
}
```
