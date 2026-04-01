# Cloudflare Workers Node.js APIs Snapshot

Source URL: `https://developers.cloudflare.com/workers/runtime-apis/nodejs/`
Observed date: `2026-04-01`

## Key facts captured

* Cloudflare Workers only provides a subset of Node.js APIs.
* Cloudflare states that some Node.js APIs are only partially supported or are non-functional stubs.
* When `nodejs_compat` is enabled with compatibility date `2024-09-23` or later, Wrangler may also inject polyfills for unsupported APIs.
* Cloudflare documents that calling unsupported polyfilled methods can throw runtime errors such as `[unenv] <method name> is not implemented yet!`.
* Application code must not assume that enabling `nodejs_compat` makes every imported Node.js helper safe to call in production request paths.
