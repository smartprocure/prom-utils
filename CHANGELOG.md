# 0.2.0

* `batchQueue` now accepts an option object which includes `batchSize` and `timeout`.
* A timer will be set if the `timeout` option is passed when the first item is enqueued.
If the timeout occurs before `batchSize` is reached, `flush` is called.

# 0.1.0

* Initial release.
