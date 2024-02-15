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
