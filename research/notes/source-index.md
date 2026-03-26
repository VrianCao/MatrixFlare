# Matrix Homeserver on Cloudflare: Source Index

状态：Draft
日期：2026-03-26
范围：Matrix homeserver on Cloudflare Workers Paid Plan

## 用途

本文件是当前研究阶段的资料索引，目的有两个：

1. 固定当前研究所依赖的官方资料范围；
2. 为后续企业级 Spec 提供可追溯来源。

本轮研究明确遵循以下边界：

* 以 **Matrix homeserver** 为目标；
* 只使用 **官方资料** 作为事实来源；
* 不以现有实现作为规范依据。

## Matrix 官方资料

### 顶层与核心协议

* Matrix latest index
  URL: <https://spec.matrix.org/latest/>
  本地快照: `research/sources/matrix-latest-index.html`

* Matrix Client-Server API `v1.17`
  URL: <https://spec.matrix.org/v1.17/client-server-api/>
  本地快照: `research/sources/matrix-v1.17-client-server-api.html`

* Matrix Server-Server API `v1.17`
  URL: <https://spec.matrix.org/v1.17/server-server-api/>
  本地快照: `research/sources/matrix-v1.17-server-server-api.html`

* Matrix Application Service API `v1.17`
  URL: <https://spec.matrix.org/v1.17/application-service-api/>
  本地快照: `research/sources/matrix-v1.17-application-service-api.html`

### Room Versions

* Matrix Room Versions overview `v1.17`
  URL: <https://spec.matrix.org/v1.17/rooms/>
  本地快照: `research/sources/matrix-v1.17-rooms.html`

* Matrix Room Version 11 `v1.17`
  URL: <https://spec.matrix.org/v1.17/rooms/v11/>
  本地快照: `research/sources/matrix-v1.17-room-v11.html`

* Matrix Room Version 12 `v1.17`
  URL: <https://spec.matrix.org/v1.17/rooms/v12/>
  本地快照: `research/sources/matrix-v1.17-room-v12.html`

## Cloudflare 官方资料

### Workers

* Workers Pricing
  URL: <https://developers.cloudflare.com/workers/platform/pricing/>
  本地快照: `research/sources/cloudflare-workers-pricing.md`

* Workers Limits
  URL: <https://developers.cloudflare.com/workers/platform/limits/>
  本地快照: `research/sources/cloudflare-workers-limits.md`

* Workers Logs
  URL: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
  本地快照: `research/sources/cloudflare-workers-logs.md`

* Workers OpenTelemetry
  URL: <https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/>
  本地快照: `research/sources/cloudflare-workers-opentelemetry.md`

* Workers Traces
  URL: <https://developers.cloudflare.com/workers/observability/traces/>
  本地快照: `research/sources/cloudflare-workers-traces.html`

* Workers Compatibility Flags
  URL: <https://developers.cloudflare.com/workers/configuration/compatibility-flags/>
  本地快照: `research/sources/cloudflare-workers-compatibility-flags.md`

* Workers RPC
  URL: <https://developers.cloudflare.com/workers/runtime-apis/rpc/>
  本地快照: `research/sources/cloudflare-workers-rpc.md`

* Service Bindings
  URL: <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/>
  本地快照: `research/sources/cloudflare-service-bindings.md`

* Smart Placement
  URL: <https://developers.cloudflare.com/workers/configuration/placement/>
  本地快照: `research/sources/cloudflare-workers-placement.md`

* Workers Secrets
  URL: <https://developers.cloudflare.com/workers/configuration/secrets/>
  本地快照: `research/sources/cloudflare-workers-secrets.md`

* Workers Gradual Deployments
  URL: <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
  本地快照: `research/sources/cloudflare-workers-gradual-deployments.md`

* Workers Versions and Deployments
  URL: <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/>
  本地快照: `research/sources/cloudflare-workers-versions-deployments.md`

* Storage Options
  URL: <https://developers.cloudflare.com/workers/platform/storage-options/>
  本地快照: `research/sources/cloudflare-storage-options.md`

### Durable Objects

* Durable Objects Limits
  URL: <https://developers.cloudflare.com/durable-objects/platform/limits/>
  本地快照: `research/sources/cloudflare-do-limits.md`

* Durable Objects Pricing
  URL: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
  本地快照: `research/sources/cloudflare-do-pricing.md`

* Durable Object Lifecycle
  URL: <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>
  本地快照: `research/sources/cloudflare-do-lifecycle.md`

* Durable Object Known Issues
  URL: <https://developers.cloudflare.com/durable-objects/platform/known-issues/>
  本地快照: `research/sources/cloudflare-do-known-issues.md`

* Durable Object RPC / Stubs
  URL: <https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/>
  本地快照: `research/sources/cloudflare-do-rpc-stubs.md`

* Durable Objects WebSockets
  URL: <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
  本地快照: `research/sources/cloudflare-do-websockets.md`

* SQLite-backed Durable Object Storage API
  URL: <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
  本地快照: `research/sources/cloudflare-do-sqlite-storage-api.md`

* Durable Object Alarms
  URL: <https://developers.cloudflare.com/durable-objects/api/alarms/>
  本地快照: `research/sources/cloudflare-do-alarms.md`

* Durable Object Migrations
  URL: <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
  本地快照: `research/sources/cloudflare-do-migrations.md`

### D1

* D1 Pricing
  URL: <https://developers.cloudflare.com/d1/platform/pricing/>
  本地快照: `research/sources/cloudflare-d1-pricing.md`

* D1 Limits
  URL: <https://developers.cloudflare.com/d1/platform/limits/>
  本地快照: `research/sources/cloudflare-d1-limits.md`

* D1 Global Read Replication
  URL: <https://developers.cloudflare.com/d1/best-practices/read-replication/>
  本地快照: `research/sources/cloudflare-d1-read-replication.md`

### KV

* Workers KV: How KV Works
  URL: <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
  本地快照: `research/sources/cloudflare-kv-how-it-works.md`

### R2

* R2 Pricing
  URL: <https://developers.cloudflare.com/r2/pricing/>
  本地快照: `research/sources/cloudflare-r2-pricing.md`

* R2 Limits
  URL: <https://developers.cloudflare.com/r2/platform/limits/>
  本地快照: `research/sources/cloudflare-r2-limits.md`

* R2 Consistency
  URL: <https://developers.cloudflare.com/r2/reference/consistency/>
  本地快照: `research/sources/cloudflare-r2-consistency.md`

### Queues

* Queues Pricing
  URL: <https://developers.cloudflare.com/queues/platform/pricing/>
  本地快照: `research/sources/cloudflare-queues-pricing.md`

### Network / Federation Edge Constraints

* Cloudflare Network Ports
  URL: <https://developers.cloudflare.com/fundamentals/reference/network-ports/>
  本地快照: `research/sources/cloudflare-network-ports.md`

* Cloudflare Access Application Paths
  URL: <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>
  本地快照: `research/sources/cloudflare-access-application-paths.md`

* Cloudflare Access Validate JWT
  URL: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>
  本地快照: `research/sources/cloudflare-access-validate-jwt.md`

* Cloudflare Access Service Tokens
  URL: <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>
  本地快照: `research/sources/cloudflare-access-service-tokens.md`

## 本轮研究重点

当前研究重点聚焦以下问题：

1. homeserver 必须实现的协议域边界；
2. Matrix 房间与同步语义在 Cloudflare 上的最自然建模；
3. Cloudflare 原语是否能承载这些语义；
4. 企业级落地时的性能、成本、迁移与运维风险。

## 后续需补充的资料

以下资料在进入企业级 Spec 正文细化前建议继续补充：

* Matrix event signing、appendices 与更细的 event schema 约束；
* Matrix media repository 的边界细节与 authenticated media 演进；
* Matrix 对 room version 兼容矩阵与旧版本房间互操作的进一步细化；
* Cloudflare 账户级配额调整、合同计费与 enterprise-specific limit override 文档。
