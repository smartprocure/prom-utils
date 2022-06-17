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

Batch calls via a local queue. Automatically executes fn
when batchSize is reached. Call queue.flush() to flush explicitly.
This can be used to batch values before writing to a database, for
example.

Batch size defaults to 500.

```typescript
const writeToDatabase = async (records) => {...}
const batchSize = 250

const queue = batchQueue(writeToDatabase, batchSize)
for (const record of records) {
  await queue.enqueue(record)
}
await queue.flush()
```
