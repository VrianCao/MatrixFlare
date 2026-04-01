# Cloudflare D1 Database Snapshot

Source URL: `https://developers.cloudflare.com/d1/worker-api/d1-database/`
Observed date: `2026-04-01`

## Key facts captured

* `D1Database.prepare()` returns a `D1PreparedStatement` and is the primary request-path entry for parameterized queries.
* `D1Database.batch()` accepts an array of prepared statements, executes them sequentially as a transaction, and returns `D1Result` objects in order.
* `D1Database.exec()` executes one or more queries without prepared statements or parameter bindings.
* The `exec()` guidance explicitly says the method can have poorer performance, is less safe, should only be used for maintenance or one-shot tasks, and accepts one or multiple queries separated by `\n`.
* Request-path schema bootstrap and hot query paths therefore need prepared statements or `batch()`, rather than feeding multiline schema literals directly into `exec()`.
