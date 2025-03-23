# 0.15.0

- `rateLimit` - Added `maxItemsPerPeriod` option along with the options from `throughputLimiter`.
- `throughputLimiter`
- Added `minWindowLength`, `period`, `expireAfter`, and `getTimeframe` options.
    - The `windowLength` option is now `maxWindowLength`.
    - Separated `throttle` and `append`. These two convenience methods were also created: `throttleAndAppend` and `appendAndThrottle`.

# 0.14.0

- `batchQueue` - Added `lastFlush`.

# 0.13.0

- Added debug statements for `pausable`.
- Bumped dependencies.

# 0.12.1

- Fixed type for `raceTimeout`.

# 0.12.0

- Added `raceTimeout`.

# 0.11.0

- Fixed: `rateLimit` should remove an item if it has rejected.
- `rateLimit` - `.finish` swallows exceptions.
- `rateLimit` - Added `length` getter.
- `batchQueue` - Added `length` getter.
- BREAKING: `pausable.proceed` changed to `pausable.maybeBlock`.

# 0.10.0

- Added `throughputLimiter` - Limit throughput (items/sec).
- Added `sleep` - Sleep for `time` ms before resolving the Promise.
- `batchQueue` - Added `maxItemsPerSec` and `maxBytesPerSec` options for throughput throttling.
- Changed testing library from jest to vitest.
- Bumped packages.

# 0.9.0

- Better types - removed all use of `any`.
- `rateLimit` - Changed the return type of the `finish` method to `Promise<void>`.

# 0.8.0

- Added `waitUntil` - Wait until the predicate returns truthy or the timeout expires.
- Changed function signature to use generics for `batchQueue`.

# 0.7.0

- Changed dependency for determining size in bytes of a value for `batchQueue`.

# 0.6.1

- `rateLimit` - Catch promise exceptions which will be re-thrown in `.add` or `.finish`.

# 0.6.0

- Added `pacemaker`.

# 0.5.0

- Changed debug code to be more logical.

# 0.4.0

- Added `batchBytes` option to `batchQueue` which triggers a queue flush if the total size of
  the queue is greater than or equal to `batchBytes`.

# 0.3.0

- `defer`
- `pausable`

# 0.2.0

- `batchQueue` now accepts an option object which includes `batchSize` and `timeout`.
- A timer will be set if the `timeout` option is passed when the first item is enqueued.
  If the timeout occurs before `batchSize` is reached, `flush` is called.

# 0.1.0

- Initial release.
