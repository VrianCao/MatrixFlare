# Cloudflare Workers RPC Snapshot

Source URL: `https://developers.cloudflare.com/workers/runtime-apis/rpc/`
Observed date: `2026-03-26`

## Key facts captured

* The maximum serialized RPC limit is `32 MiB`.
* For payloads larger than the normal serialized limit, Cloudflare recommends using stream-based transfer such as byte-oriented `ReadableStream`.
* The RPC docs state that `ReadableStream`, `WritableStream`, `Request`, and `Response` bodies are streamed with flow control, which is how transfers can exceed the typical `32 MiB` serialized limit.
* Durable Object RPC guidance refers readers back to Workers RPC for complete details, so this snapshot is the shared transport-ceiling reference for Service Binding RPC and Durable Object RPC design.
