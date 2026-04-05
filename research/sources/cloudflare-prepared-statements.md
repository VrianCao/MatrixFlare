# Cloudflare D1 Prepared Statements Snapshot

Source URL: `https://developers.cloudflare.com/d1/worker-api/prepared-statements/`
Observed date: `2026-04-01`

## Key facts captured

* `bind()` returns a `D1PreparedStatement`, preserving the prepared-statement surface for reuse and further execution.
* Cloudflare recommends prepared statements as the normal approach because binding values enables statement reuse and prevents SQL injection.
* `run()` executes the prepared statement and returns `D1Result`, including `success`, `meta`, and `results`.
* The prepared-statement surface also includes `first()`, `all()`, and `raw()`, which runtime wrappers must preserve without reshaping the object into a partial substitute.
