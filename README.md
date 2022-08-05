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

Automatically executes `fn` when `batchSize` is reached or timeout is
reached, if set. The timer will be started when the first item is
enqueued and reset when flush is called explicitly or implicitly.

Call `queue.flush()` to flush explicitly.

Batch size defaults to 500. The last result of calling `fn` can be
obtained by referencing `lastResult` on the returned object.

```typescript
const writeToDatabase = async (records) => {...}
const batchSize = 250

const queue = batchQueue(writeToDatabase, {batchSize})
for (const record of records) {
  await queue.enqueue(record)
}
await queue.flush()
```
