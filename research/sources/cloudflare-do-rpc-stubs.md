# Cloudflare Durable Object RPC/Stubs Snapshot

Source URL: `https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/`
Observed date: `2026-03-26`

## Key facts captured

* Durable Objects can expose public methods, and callers invoke those methods directly on object stubs using RPC.
* The Durable Object stubs guide explicitly points readers to the Workers RPC documentation for complete RPC details.
* Durable Object stubs also support `fetch()` as an alternative transport, but public-method RPC is a first-class internal call surface.
* Therefore any spec statement that applies Workers RPC transport limits to Durable Object method-call RPC must keep both the DO stubs guide and Workers RPC docs pinned together.
