# Cloudflare Workers Rate Limiting Binding Snapshot

Source URL: `https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/`
Observed date: `2026-04-02`

## Key facts captured

* Workers can bind rate limiters directly in Wrangler config by declaring `ratelimits` entries with a binding name, `namespace_id`, and `simple.limit` / `simple.period`.
* The `simple.period` value is restricted to `10` or `60` seconds.
* Rate limiting is local to a Cloudflare location, which means the binding is not intended for global primary-accounting or authorization truth.
* Cloudflare documents the feature as eventually consistent and explicitly says the API should be treated as permissive, not as a strict security boundary.
* A Worker can still use the binding to implement coarse request shaping before application code enters heavier request paths, but correctness-sensitive quotas must remain in application-owned logic.
