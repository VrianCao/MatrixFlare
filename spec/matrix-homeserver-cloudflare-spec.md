# Matrix Homeserver on Cloudflare

状态：Formal Draft v0.1  
日期：2026-03-24  
目标：为运行在 Cloudflare Workers Paid Plan 上的 Matrix homeserver 提供可直接落地的企业级 Development Spec

## 1. Document Control

### 1.1 Status

本文件是正式开发规格说明书首版，已从研究备忘录升级为实现导向文档。  
它不是 Matrix 规范的替代品；它定义的是：

* 以 Matrix `v1.17` 官方规范为协议基线的实现边界；
* 在 Cloudflare 当前公开平台约束下的可行架构；
* 开发、部署、迁移、运维、恢复与成本控制规则。

### 1.2 Scope

本 Spec 覆盖：

* Matrix homeserver
* Cloudflare Workers Paid Plan
* Cloudflare 原语：Workers、Durable Objects、D1、R2、KV、Queues、DO Alarms、Service Bindings
* Matrix Client-Server API
* Matrix Server-Server API
* Matrix Application Service API
* Matrix 内容仓库、E2EE 传输、联邦、目录、搜索、观测、运维

本 Spec 不直接覆盖：

* 独立 Identity Service
* 独立 Push Gateway
* 自建 TURN 基础设施
* 非 Matrix 标准客户端专用扩展协议
* 单部署内多 homeserver 域名多租户承载

### 1.3 Intended Audience

本文件面向：

* 架构师
* 后端开发
* Edge/Cloudflare 开发
* SRE / 平台工程
* 安全工程
* QA / 协议测试工程

### 1.4 Reading Order

推荐阅读顺序：

1. `2` 到 `12`：先理解系统边界、平台约束和核心建模。
2. `13` 到 `18`：再进入各协议域实现。
3. `19` 到 `25`：最后阅读安全、部署、恢复、测试和成本。

## 2. Executive Summary

本系统是一个原生面向 Cloudflare 边缘平台设计的 Matrix homeserver，而不是把传统单体 homeserver 机械迁移到 Workers。

核心判断如下：

* Matrix 正确性的中心不是“数据库能否横向扩展”，而是“每个房间、每个用户、每个远端服务器是否有清晰的主权状态机”。
* Cloudflare 上最自然的主权单元是 Durable Object，而不是 D1 或 KV。
* Worker 负责边缘接入、鉴权、路由、聚合、长轮询持有与流式响应。
* `RoomDO(room_id)` 负责房间 DAG、state、auth、事件准入和单房间串行化。
* `UserDO(user_id)` 负责用户/设备/session/account data/to-device/E2EE 计数与用户增量流。
* `RemoteServerDO(server_name)` 负责联邦出站事务、重试、缺事件修复调度和服务端幂等。
* D1 只用于衍生查询面与索引，不承担房间状态真相。
* R2 用于媒体对象、冷历史、归档与灾备导出。
* KV 只用于缓存，不用于任何要求即时一致性的路径。

本 Spec 的关键 Cloudflare 平台结论如下：

* Workers Paid Plan 包含 `$5/月` 基础费用、`10M` Worker 请求/月、`30M` CPU ms/月。
* HTTP Worker 没有硬性 wall time 上限，只要客户端保持连接；这使 Worker 可以安全持有 `/sync` 长轮询。
* Durable Object 单对象本质上是单线程状态机，软上限约 `1000 req/s`；每个 SQLite-backed DO 最大 `10 GB`。
* D1 单数据库单线程、单库最大 `10 GB`；读副本是异步复制，只能通过 Sessions API 获得顺序一致性。
* KV 是最终一致性，跨地域可滞后 `60s+`，不能用于 token 撤销、房间状态、媒体存在性等强一致路径。
* R2 对对象操作是强一致的；经 Worker/R2 binding 直接访问不受 CDN 缓存陈旧问题影响。
* Cloudflare 代理默认不应假设联邦入站走 `8448`；必须通过 `443/8443` 与 `/.well-known/matrix/server` / SRV 设计联邦发现。

本 Spec 的最高优先级设计约束如下：

* `/sync` 长轮询必须由 Worker 持有，不能由 `UserDO` 持有。
* DO 内的权威写路径不得在提交前等待外部 I/O。
* 任何 Worker 与 DO 之间的接口都必须前后兼容，因为 Cloudflare 对 Worker/DO 代码更新是全局最终一致发布。
* Durable Object migration 必须与普通代码发布解耦，单独部署。

## 3. Goals and Non-Goals

### 3.1 Goals

本系统的目标是：

* 提供一个可联邦、可运行 E2EE 传输、可承载企业级运维要求的 Matrix homeserver。
* 完整支持 Matrix homeserver 的核心职责，而不是只做“本地聊天后端”。
* 在 Cloudflare 当前公开产品边界内实现，不依赖不存在或未验证的运行时能力。
* 以主权状态机为核心，明确每类数据的 authority、持久化位置和重建路径。
* 在低到中等规模下保持成本可预测，在高并发下具备明确降级策略。
* 使开发团队可以按本文档直接拆分模块、建立 repo、编写接口、制定测试计划并开始实现。

### 3.2 Non-Goals

本系统的非目标如下：

* 不把 D1 当作房间事件或房间当前状态的权威数据库。
* 不把 KV 当作 session、token 撤销、媒体存在性、联邦幂等、房间状态的来源。
* 不依赖客户端或远端服务器接受非标准 Matrix 路由或自定义上传协议才能完成标准功能。
* 不在同一逻辑部署中托管多个独立 homeserver 域名并共享状态层。
* 不在 DO 内长期持有 `/sync` HTTP 请求。
* 不在首版架构中引入任何未调研的 Cloudflare 产品作为关键依赖。

## 4. Product Assumptions

### 4.1 Deployment Assumptions

本 Spec 采用以下部署假设：

* 一个部署环境只服务一个 Matrix homeserver 域名。
* 每个环境都有独立的 Cloudflare Worker、DO namespaces、D1 数据库、R2 bucket、KV namespace、Queues。
* 使用 ES modules Worker。
* 使用显式 `compatibility_date`，且只在通过回归验证后推进。
* 使用 `wrangler deploy` / `wrangler versions upload+deploy` 进行发布。
* 需要 Matrix 联邦时，域名和 TLS 由 Cloudflare 代理托管，联邦入站通过 `443` 或 `8443` 设计，而不是默认 `8448`。

### 4.2 Tenancy Assumptions

首版是单租户设计：

* 一个部署环境只承载一个 homeserver 逻辑租户。
* 用户、房间、设备、媒体、联邦身份、签名密钥都属于该单一租户。
* 如未来需要多租户，推荐方案是“每租户独立部署单元”，而不是同一状态平面内混租。

### 4.3 Operational Assumptions

运行假设如下：

* 运维团队拥有 Cloudflare 账号、Zone、DNS、R2、D1、Queues、Workers 配置权。
* 运维团队能够管理 Worker secrets 或 Account-level Secrets Store。
* 生产环境启用结构化日志。
* 生产环境有独立 staging 环境。
* 生产环境具备 R2 导出归档和灾备恢复演练流程。
* 生产环境接受 Cloudflare 平台级限制并围绕其设计降级，而不是期望平台为 Matrix 语义让步。

### 4.4 Cloudflare Plan Assumptions

已知前提：

* Workers Paid Plan 已启用。

必须强调的额外约束：

* Worker 请求体上限取决于 Cloudflare account/zone plan，而不是 Workers plan。
* 因此 `m.upload.size` 不能只取应用配置，还必须受 zone plan 的请求体上限约束。

## 5. Normative References

### 5.1 Matrix

以下 Matrix 官方资料为本 Spec 的规范基线：

* Matrix Specification latest index  
  <https://spec.matrix.org/latest/>
* Matrix Client-Server API `v1.17`  
  <https://spec.matrix.org/v1.17/client-server-api/>
* Matrix Server-Server API `v1.17`  
  <https://spec.matrix.org/v1.17/server-server-api/>
* Matrix Application Service API `v1.17`  
  <https://spec.matrix.org/v1.17/application-service-api/>
* Matrix Room Versions overview `v1.17`  
  <https://spec.matrix.org/v1.17/rooms/>
* Matrix Room Version `11`  
  <https://spec.matrix.org/v1.17/rooms/v11/>
* Matrix Room Version `12`  
  <https://spec.matrix.org/v1.17/rooms/v12/>

当前本地快照显示 `latest` 对应 `v1.17`。

### 5.2 Cloudflare

以下 Cloudflare 官方资料为本 Spec 的平台基线：

* Workers Pricing  
  <https://developers.cloudflare.com/workers/platform/pricing/>
* Workers Limits  
  <https://developers.cloudflare.com/workers/platform/limits/>
* Versions & Deployments  
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/>
* Gradual Deployments  
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
* Secrets  
  <https://developers.cloudflare.com/workers/configuration/secrets/>
* Service Bindings  
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/>
* Storage Options  
  <https://developers.cloudflare.com/workers/platform/storage-options/>
* Placement  
  <https://developers.cloudflare.com/workers/configuration/placement/>
* Workers Logs  
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
* OpenTelemetry Export  
  <https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/>
* Durable Objects Limits  
  <https://developers.cloudflare.com/durable-objects/platform/limits/>
* Durable Objects Pricing  
  <https://developers.cloudflare.com/durable-objects/platform/pricing/>
* Durable Object Lifecycle  
  <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>
* Durable Object WebSockets / Hibernation  
  <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
* SQLite-backed DO Storage API  
  <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
* DO Alarms  
  <https://developers.cloudflare.com/durable-objects/api/alarms/>
* DO Migrations  
  <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
* DO Known Issues  
  <https://developers.cloudflare.com/durable-objects/platform/known-issues/>
* D1 Pricing  
  <https://developers.cloudflare.com/d1/platform/pricing/>
* D1 Limits  
  <https://developers.cloudflare.com/d1/platform/limits/>
* D1 Global Read Replication  
  <https://developers.cloudflare.com/d1/best-practices/read-replication/>
* Workers KV: How KV Works  
  <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
* R2 Pricing  
  <https://developers.cloudflare.com/r2/pricing/>
* R2 Limits  
  <https://developers.cloudflare.com/r2/platform/limits/>
* R2 Consistency  
  <https://developers.cloudflare.com/r2/reference/consistency/>
* Queues Pricing  
  <https://developers.cloudflare.com/queues/platform/pricing/>
* Network Ports  
  <https://developers.cloudflare.com/fundamentals/reference/network-ports/>

### 5.3 Source Traceability

本地快照与索引见：

* `research/notes/source-index.md`
* `research/sources/`

## 6. System Context

### 6.1 External Actors

外部参与方包括：

* Matrix 客户端
* 本地用户
* 远端 homeserver
* Application Service
* 平台运维人员
* 安全与合规人员

### 6.2 External Systems

系统交互外部系统如下：

* Cloudflare DNS / TLS / Edge proxy
* Cloudflare Workers runtime
* Cloudflare Durable Objects
* Cloudflare D1
* Cloudflare R2
* Cloudflare KV
* Cloudflare Queues
* 可选外部 OTel 接收端
* 外部 IdP / SSO 系统
* 外部 Push Gateway
* 外部 TURN 服务

### 6.3 Trust Boundaries

必须显式区分以下信任边界：

* 客户端与公网 Worker 边界
* 远端 homeserver 与联邦入口边界
* 公网 Worker 与内部主权 DO 边界
* 权威状态层与衍生索引层边界
* 应用密钥/签名材料与普通配置边界
* 运营控制面与业务请求面边界

### 6.4 High-Level Context Diagram

```text
Client / Remote HS / AS
        |
        v
  Public Edge Worker
        |
        +--> UserDO(user_id)
        |
        +--> RoomDO(room_id)
        |
        +--> RemoteServerDO(server_name)
        |
        +--> D1 (derived indexes only)
        |
        +--> R2 (media / cold history / exports)
        |
        +--> KV (cache only)
        |
        +--> Queues + DO Alarms (async)
```

## 7. Architectural Principles

### 7.1 Correctness Principles

本架构遵循以下正确性原则：

* 每个用户有唯一主权单元：`UserDO(user_id)`。
* 每个房间有唯一主权单元：`RoomDO(room_id)`。
* 每个远端服务器的出站联邦有唯一主权单元：`RemoteServerDO(server_name)`。
* 任何会改变真相状态的逻辑都必须进入对应主权 DO。
* 任何房间状态判断都必须以房间版本策略和房间当前已接受图为准。
* 任何衍生索引都必须可以重建。

### 7.2 Storage Principles

存储原则如下：

* DO SQLite storage 是权威小世界状态。
* D1 只承载全局查询面、目录、搜索、统计和控制面数据。
* R2 承载大对象和冷数据。
* KV 只做缓存。
* 所有权威写入必须先落主权 DO，再派生到其他系统。

### 7.3 Concurrency Principles

Cloudflare DO 单对象虽然单线程，但请求可能因 `await` 发生交错。  
因此必须遵守以下规则：

* 主权写路径在提交前不得等待外部网络 I/O。
* 主权写路径只允许访问本地 DO storage。
* 任何远端拉取、索引写入、通知投递、媒体处理都在提交后异步执行。
* RoomDO、UserDO、RemoteServerDO 都采用“本地提交阶段 + 异步副作用阶段”两段式处理。

### 7.4 Cost Principles

* `/sync` 长轮询持有在 Worker，而不是 DO。
* 长时间空闲连接优先用 Worker 请求 wall time 或 DO hibernation WebSocket，而不是非可休眠 DO 请求。
* 大对象必须流式处理，严禁整包缓冲到 128 MB isolate 内存。
* 热路径上不做 D1 强依赖。
* 大范围 fanout 以队列/增量流/批处理为主。

### 7.5 Evolvability Principles

* 房间版本差异必须封装在 `RoomVersionStrategy` 层，不得散落在业务代码。
* Worker 与 DO 的接口必须前后兼容。
* D1 schema 采用先加后切换再清理的演进策略。
* 所有主权状态都要具备导出、重放或重建路径。

## 8. Runtime Topology

### 8.1 Edge Entry Workers

推荐采用三个 Worker 入口角色：

* `gateway-worker`
  * 公网入口
  * 承载 `/_matrix/client/*`、`/_matrix/federation/*`、`/_matrix/media/*`、`/_matrix/key/*`、`/.well-known/*`
  * 负责 auth、联邦签名校验、路由、流式响应、`/sync` 长轮询
* `jobs-worker`
  * Queue consumer / 定时任务 / 重建任务
  * 负责缩略图、索引、归档、补偿、回放
* `ops-worker`
  * 仅内部控制面使用
  * 负责导出、修复、重建、迁移、审计

说明：

* 角色可以在首版代码仓库中实现为同一 bundle 的不同 entrypoint，也可以是多个独立 Worker。
* Worker-to-Worker 通信必须使用 Service Bindings，而不是同 Zone 公网 `fetch()`。
* Worker -> DO 通信默认使用 RPC；只有 WebSocket upgrade、原始 HTTP 透传等少数场景使用 `fetch()`

### 8.2 Durable Object Classes

首版必须具备以下 DO 类：

| DO Class | Key | Authority | Primary Responsibility |
| --- | --- | --- | --- |
| `UserDO` | `user_id` | User state | session、device、account data、to-device、E2EE 计数、presence、用户流 |
| `RoomDO` | `room_id` | Room state | event DAG、state、auth、membership、timeline、ephemeral room state |
| `RemoteServerDO` | `server_name` | Federation outbound | 出站事务、缺事件恢复调度、联邦退避、远端幂等 |

可选附加 DO 类：

* `AppServiceDO(as_id)`：如果需要把 AS 事务队列也建模为主权状态机。
* `RepairDO(job_id)`：如果要将长时间修复作业做成单独协调单元。

### 8.3 Supporting Storage Systems

| Product | Role | Allowed Uses | Forbidden Uses |
| --- | --- | --- | --- |
| D1 | Derived query plane | 搜索、目录、控制面、媒体目录、统计、审计 | 房间 state truth、token 撤销真相 |
| R2 | Blob/cold/archive | 媒体、冷历史、导出、灾备快照、缩略图缓存 | 低延迟权威 state |
| KV | Cache only | 稳定配置缓存、非关键 lookup 缓存、远端 well-known 缓存副本 | auth、state、media existence、federation 幂等 |
| Queues | Async buffering | 索引、缩略图、导出、投递补偿 | 权威事务提交 |
| DO Alarms | Per-object retry/schedule | 联邦退避、typing 过期、补偿、批处理触发 | 长周期统一调度替代品 |

### 8.4 Async Processing Topology

异步任务源头：

* RoomDO 提交事件后发出索引/联邦/通知工作项
* UserDO 更新设备/账户数据后发出目录/搜索/通知工作项
* Media 上传完成后发出缩略图和归档工作项
* RemoteServerDO 在失败或缺事件场景下通过 alarm 驱动重试

异步原则：

* 所有 Queue 消息必须幂等。
* 所有 Queue 消息必须能通过唯一键去重。
* 异步任务失败不能破坏权威状态，只能导致衍生面滞后。

### 8.5 Cloudflare Hard Limits and Usage Rules

开发团队在实现时必须显式考虑以下平台硬约束：

| Area | Constraint | Design Impact |
| --- | --- | --- |
| Worker memory | `128 MB` per isolate | 媒体与归档必须流式处理，禁止整包缓冲 |
| Worker CPU | 默认 `30s`，Paid 可升到 `5 min` | 大型重放、缩略图、修复任务不能在公网请求热路径做 |
| Worker duration | HTTP 无硬性 wall time 上限 | `/sync` 可在 Worker 持有 |
| Subrequests | Paid 默认 `10,000/request` | 仍需避免无界 fanout 和递归服务调用 |
| Simultaneous outgoing connections | `6/request` | 联邦拉取、远端媒体获取必须限并发 |
| Worker size | `10 MB` | 房间版本算法、加密与媒体处理依赖需谨慎控制 bundle 体积 |
| Service Bindings | 单请求最多 `32` 次 Worker invocations；且不计入 simultaneous open connections | 微服务切分可行，但调用链必须浅 |
| DO classes | Paid 每账号 `500` 类 | DO 类数量必须克制，按 bounded context 设计 |
| DO storage | SQLite-backed 单对象 `10 GB` | RoomDO/UserDO 必须做冷热分层和导出 |
| D1 size | 单数据库 `10 GB` | 搜索、目录、媒体目录必须支持分库/分片 |
| R2 single-part upload | `5 GiB`；经 Worker 入站仍受 zone body limit 约束 | 标准客户端上传上限必须取更小者 |
| Queue / Alarm wall time | 单次 `15 min` | 长重建任务要做分片与续跑 |

Placement / RPC 规则：

* Smart Placement 只影响 `fetch` handler，不影响 RPC methods 或 named entrypoints。
* Durable Objects 已自动与其嵌入式 SQLite 数据共置，不需要额外 placement 配置。
* 因本系统核心热路径主要是 Worker -> DO RPC，`gateway-worker` 默认不启用 Smart Placement。
* 若未来为只读 D1 查询单独拆出 `fetch` 型 backend Worker，可评估仅对该 Worker 启用 Smart Placement。

## 9. Bounded Contexts

### 9.1 Identity and Devices

该域负责：

* 注册、登录、刷新、登出
* 设备列表与设备元数据
* access token / refresh token 生命周期
* 用户 profile
* global account data
* presence

主权单元：

* `UserDO(user_id)`

### 9.2 Rooms and State Resolution

该域负责：

* 建房、加入、邀请、离开、封禁
* timeline event
* state event
* auth rules
* state resolution
* room summary
* 房间历史与分页
* receipts / typing / membership projection

主权单元：

* `RoomDO(room_id)`

### 9.3 Sync and Notifications

该域负责：

* `/sync`
* unread counts
* ephemeral room events
* room account data
* to-device
* device list changes
* presence 汇总

主权组合：

* Worker 持有 HTTP 长轮询
* `UserDO` 维护用户增量流
* `RoomDO` 按需投影房间 delta

### 9.4 E2EE Transport

该域负责：

* `/keys/upload`
* `/keys/query`
* `/keys/claim`
* cross-signing
* fallback key 生命周期
* room key backup 元数据与大对象

主权单元：

* `UserDO(user_id)`

### 9.5 Media Repository

该域负责：

* 内容上传、下载、缩略图
* 远端媒体缓存
* 媒体元数据
* 上传限制
* 冷媒体生命周期

主权分工：

* Worker 负责入口和鉴权
* R2 负责对象本体
* `UserDO` 负责 pending MXC 的用户绑定与限额
* D1 负责媒体目录与派生索引

### 9.6 Federation

该域负责：

* 服务器发现
* 服务器签名与公钥发布/获取
* 入站事务验签与分发
* 出站事务队列
* 缺事件修复
* backfill

主权分工：

* Worker 负责 ingress 验签和路由
* `RemoteServerDO(server_name)` 负责出站与远端状态
* `RoomDO` 负责房间语义裁决
* `UserDO` 负责 to-device 与用户域联邦语义

### 9.7 Application Services

该域负责：

* AS registration
* namespace ownership
* HS -> AS transactions
* AS ping / health
* user / alias query

推荐实现：

* 控制面配置存 D1
* token 存 secrets
* 事务投递使用 Queue + 幂等表，或 `AppServiceDO`

### 9.8 Search and Directory

该域负责：

* 用户目录
* 公共房间目录
* 房间消息搜索
* 别名/房间查找

该域是纯衍生域：

* 权威写入永远来自 `UserDO` / `RoomDO`
* D1 可重建

### 9.9 Operations and Control Plane

该域负责：

* 配置
* 迁移
* 灾备导出
* 修复
* 审计
* 成本监控

要求：

* 不直接暴露到公网
* 只允许内部 Worker/service binding 或受限 operator 路由访问

## 10. Data Model

### 10.1 Core Entity Catalog

| Entity | Authority | Primary Store | Secondary Store |
| --- | --- | --- | --- |
| User | `UserDO` | DO SQLite | D1 identity index |
| Device | `UserDO` | DO SQLite | D1 device search index |
| Session / Token | `UserDO` | DO SQLite | none |
| Room | `RoomDO` | DO SQLite | D1 directory/search projection |
| Event DAG | `RoomDO` | DO SQLite | R2 cold archive |
| Room current state | `RoomDO` | DO SQLite | none |
| User sync stream | `UserDO` | DO SQLite | none |
| To-device queue | `UserDO` | DO SQLite | none |
| One-time / fallback keys | `UserDO` | DO SQLite | none |
| Remote server outbound queue | `RemoteServerDO` | DO SQLite | D1 metrics optional |
| Media blob | R2 | R2 | D1 media catalog |
| Media metadata | Worker + D1 | D1 + R2 metadata | KV cache optional |
| Search index | Derived | D1 shards | none |

### 10.2 Room Graph Model

Room 不是 append-only log，而是带部分有序关系和状态解析规则的事件图。  
因此 `RoomDO` 必须至少维护以下逻辑记录：

* `events`
  * `event_id`
  * `room_pos`
  * `type`
  * `state_key`
  * `sender`
  * `origin_server_ts`
  * `depth`
  * `is_state`
  * `is_redacted`
  * `content_ref`
* `event_json_hot`
  * 近期 canonical JSON
* `prev_edges`
  * `event_id -> prev_event_id`
* `auth_edges`
  * `event_id -> auth_event_id`
* `state_snapshots`
  * `snapshot_id`
  * `base_snapshot_id`
  * `resolved_from_extremities_hash`
* `state_entries`
  * `(snapshot_id, type, state_key) -> event_id`
* `forward_extremities`
* `membership_projection`
* `ephemeral_receipts`
* `typing_state`
* `archive_manifest`

### 10.3 User and Device Model

`UserDO` 至少维护以下逻辑记录：

* `sessions`
  * `session_id`
  * `token_hash`
  * `device_id`
  * `expires_at`
  * `revoked_at`
* `devices`
  * `device_id`
  * `display_name`
  * `last_seen_ts`
  * `last_ip`
* `device_keys`
  * device identity keys
  * signatures
* `one_time_keys`
  * algorithm
  * key_id
  * claimed_at
* `fallback_keys`
  * algorithm
  * key material
  * used_at
* `cross_signing`
  * master/self-signing/user-signing
* `to_device_queue`
  * per-device pending EDU/event
* `account_data_global`
* `account_data_room`
* `presence_state`
* `user_stream`
  * `stream_pos`
  * `kind`
  * `payload_ref`

### 10.4 Federation Model

`RemoteServerDO` 至少维护：

* `outbound_txns`
  * `txn_id`
  * immutable payload ref
  * attempt count
  * next_retry_at
* `inbound_txn_dedupe`
  * `origin + txn_id`
* `remote_key_cache`
  * `server_name`
  * `key_id`
  * `valid_until_ts`
* `gap_repair_jobs`
  * room/event scoped recovery tasks
* `well_known_cache`
  * server discovery result

### 10.5 Media and Archive Model

R2 对象布局建议：

* `media/local/{media_id}`
* `media/remote/{origin_server}/{media_id}`
* `media/thumb/local/{media_id}/{variant}`
* `media/thumb/remote/{origin_server}/{media_id}/{variant}`
* `archive/rooms/{room_id}/segments/{start_room_pos}-{end_room_pos}.jsonl.zst`
* `archive/users/{user_id}/snapshots/{ts}.json.zst`
* `exports/control/{ts}/...`

媒体目录 D1 至少包含：

* `mxc_uri`
* `owner_user_id`
* `origin_server`
* `media_id`
* `content_type`
* `size_bytes`
* `sha256`
* `filename`
* `created_at`
* `is_local`
* `is_cached_remote`
* `retention_class`

实现约束：

* 下载路径所需的最小元数据必须同时存在于 R2 object metadata 或对象 key 结构中，不能让 D1 成为媒体下载的单点前提。
* D1 中的媒体目录主要用于查询、清理、审计和缓存管理。

### 10.6 Indexing Model

所有 D1 索引都必须声明来源事件与幂等键：

* 搜索索引幂等键：`event_id`
* 公共房间目录幂等键：`room_id + version`
* 用户目录幂等键：`user_id + version`
* 媒体目录幂等键：`mxc_uri`

索引写入失败时：

* 不影响权威状态提交
* 必须进入重试或重建队列

## 11. Consistency Model

### 11.1 Global Consistency Statement

本系统不是全局线性化数据库。  
它是：

* `per-room` 强串行主权
* `per-user` 强串行主权
* `per-remote-server` 强串行出站
* `global derived views` 最终一致

### 11.2 Per-Room Consistency

对同一 `room_id`：

* 所有权威事件准入、state 更新、extremity 变化、membership 变化都在同一 `RoomDO` 内串行裁决。
* RoomDO 提交完成后，房间真相立即一致。
* 搜索、目录、远程通知、归档可以滞后。

### 11.3 Per-User Consistency

对同一 `user_id`：

* session、device、account data、to-device、presence、用户增量流都在 `UserDO` 内线性化。
* `/keys/claim` 必须确保 one-time key 至多返回一次。
* `device_one_time_keys_count` 与 `/keys/upload` 返回计数必须来源于同一用户主权状态。

### 11.4 Per-Remote-Server Consistency

对同一 `server_name`：

* 出站事务顺序由 `RemoteServerDO` 唯一决定。
* 重试时复用同一 `txn_id` 与同一 payload。
* 入站 `origin + txn_id` 去重必须稳定。

### 11.5 Cache Consistency

* KV 只承载可陈旧缓存。
* KV 中 negative lookup 同样可能陈旧，因此不能缓存为权威“不存在”结论。
* R2 通过 Worker binding 读取时依赖对象强一致；若未来使用 R2 custom domain 直出，则必须显式处理 CDN 缓存陈旧。

### 11.6 D1 Consistency

* D1 绝不承载权威房间状态。
* 启用 D1 read replication 时，任何需要“读到自己刚写的结果”的查询，必须通过 Sessions API + bookmark 执行。
* 目录、搜索类接口默认接受最终一致，不强制 read-after-write。

## 12. Request Routing Model

### 12.1 Client-Server Routing

公网路由由 `gateway-worker` 统一接收。

核心路由：

* `/_matrix/client/*`
* `/_matrix/media/*`
* `/_matrix/key/*`
* `/_matrix/client/v1/media/*`
* 兼容性路由：`/_matrix/media/v3/*`

路由规则：

* 认证态请求先进入 `UserDO` 鉴权和设备确认。
* 房间写操作再进入 `RoomDO`。
* 用户域写操作只进入 `UserDO`。
* 大文件响应必须流式输出。

### 12.2 Federation Routing

联邦入口路由：

* `/_matrix/federation/*`
* `/_matrix/key/*`
* `/.well-known/matrix/server`

联邦入口先后顺序：

1. TLS / Host 入口校验
2. `Authorization: X-Matrix` 验证
3. 远端公钥获取/缓存
4. 入站事务幂等检查
5. 按内容分发到 `RoomDO` / `UserDO`

### 12.3 Media Routing

媒体路由：

* 客户端上传/下载优先使用最新版 client routes
* 为兼容客户端，继续提供 deprecated `/_matrix/media/v3/*`
* 联邦拉取本地媒体必须实现 `/_matrix/federation/v1/media/*`

媒体响应策略：

* 下载默认由 Worker 从 R2 绑定流式转发
* 鉴权媒体不做裸 R2 公开直出
* 远端媒体 miss 时按需拉取并缓存

### 12.4 Well-Known and Discovery Routing

必须支持：

* `/.well-known/matrix/server`
* `/.well-known/matrix/client`

联邦设计要求：

* 不把 `8448` 当作 Cloudflare 代理前提
* 优先使用 `443`
* 需要额外 hostname 时可使用 `8443`

## 13. Sync Subsystem

### 13.1 Sync Goals

`/sync` 不是普通查询接口，而是设备视角的增量流接口。  
其目标是：

* 以单调 token 交付设备可消费的最新状态
* 提供 long-poll 行为
* 允许 timeline limited / gap
* 聚合用户域、房间域、to-device、E2EE、presence、account data
* 在 Cloudflare 上成本可控

### 13.2 Token Model

`next_batch` 对外必须被视为 opaque token。  
内部建议格式：

* 版本前缀：`s1`
* 用户流位置：`user_stream_pos`
* 可选 capability bits：如 `use_state_after`
* 完整性校验：HMAC 或签名

原则：

* token 单调递增
* 同一 token 可在超时后重复使用
* 无新数据时允许返回相同 `next_batch`
* token 不承载可变服务端状态引用

### 13.3 Incremental Stream Model

系统采用“用户主权流”模型：

* `UserDO` 为每个用户维护单调递增的 `user_stream_pos`
* 任何对该用户可见的 sync 变化都在 `UserDO` 追加一条流记录
* `RoomDO` 只负责房间权威事实和房间投影，不直接构造完整 `/sync` 响应

用户流记录种类：

* `room_delta`
* `invite_delta`
* `leave_delta`
* `room_account_data`
* `global_account_data`
* `to_device`
* `presence`
* `device_lists`
* `device_one_time_keys_count`
* `device_unused_fallback_key_types`
* `receipt_update`
* `typing_update`

### 13.4 Worker-held Long Poll Design

#### 13.4.1 Why Worker Holds the Poll

`/sync` 长轮询必须由 Worker 持有，原因如下：

* HTTP Worker 没有硬性 wall time 上限，只要客户端连接存在。
* Durable Objects 会对非可休眠活跃时间计 wall-clock duration 费用。
* 如果把 `/sync` 等待直接持有在 `UserDO`，在线设备数会直接放大 DO duration 成本。

#### 13.4.2 Preferred Wakeup Model

推荐模型：

* Worker 持有客户端 HTTP 长轮询请求。
* Worker 与 `UserDO` 建立轻量唤醒通道。
* `UserDO` 只在有新 `user_stream_pos` 时发出 wakeup。
* Worker 收到 wakeup 后再请求 `UserDO.collectSince()` 与相关 `RoomDO.project()`。

实现优先级：

* 首选：`UserDO` 作为 WebSocket server，使用 DO WebSocket Hibernation API 持有 wake 连接。
* 原因：DO hibernation 在空闲时不计 duration，适合 sparse wakeup。

注意事项：

* WebSocket 仅作为 Worker 与 `UserDO` 的唤醒通道，不承载客户端协议本身。
* 代码更新会断开 DO WebSocket，Worker 必须将其视为正常 `/sync` 早返回原因。
* 若 wake 通道在当前 runtime 组合上验证不稳定，则允许以“低频自适应轮询 `UserDO`”作为降级方案，但不得改变“Worker 持有长轮询”这个原则。

#### 13.4.3 Response Assembly

`gateway-worker` 组装 `/sync` 的流程：

1. 解析并验证 access token。
2. 解析 `since` token。
3. 调用 `UserDO.collectSince()` 获取用户流增量摘要。
4. 对涉及房间的 delta，按需调用 `RoomDO.projectForSync()`。
5. 合并：
   * `rooms`
   * `account_data`
   * `to_device`
   * `presence`
   * `device_lists`
   * `device_one_time_keys_count`
6. 生成 `next_batch`。
7. 流式返回 JSON。

### 13.5 Failure and Retry Behavior

* Worker 在等待阶段被 runtime 更新中断时，客户端重试 `/sync` 即可。
* wake 通道断开时，Worker 立即返回空响应或执行一次最终 `collectSince()`。
* 房间投影失败不得推进 token。
* 单个房间投影失败时，可返回整体 `500`，不允许用推进 token 的方式跳过房间 delta。

### 13.6 Cost Controls

* 默认 `timeout` 上限建议 `30s`。
* 使用 filter ID 或 inline filter hash 做结果缓存键。
* 强制 lazy-load members。
* 不在空房间或离线设备上维持 wake 订阅。
* 对高频 typing/receipt 做聚合压缩。
* 对大房间 timeline 采用 limited 响应与 gap 修复，而不是一次性输出全部事件。

### 13.7 `use_state_after` Support

本系统必须支持最新 `/sync` 的 `use_state_after=true` 语义：

* 当客户端设置 `use_state_after=true` 时，服务端返回 `state_after` 并省略 `state`
* 当未设置或不支持时，保持传统 `state` 语义

实现要求：

* `RoomDO.projectForSync()` 必须同时能生成 “timeline start 前状态差量” 与 “timeline end 后状态差量”
* token 本身不区分 `state` / `state_after`，但响应生成器必须根据请求参数选择输出结构

## 14. Room Processing Subsystem

### 14.1 RoomDO Responsibilities

`RoomDO` 的职责是：

* 房间 DAG 权威持久化
* 事件准入
* state resolution
* auth rules 判断
* room version 行为分派
* membership 变更
* 房间 timeline stream 序列号
* ephemerals：typing / receipt 当前视图
* 本地用户 fanout 元信息生成
* 联邦出站所需 payload 提供

### 14.2 Event Admission Pipeline

所有进入房间的事件，无论来自：

* 本地客户端
* Application Service
* 联邦入站

都必须进入同一准入管道：

1. 基础语法校验
2. room version 选择
3. event ID / hash / canonical JSON 规范校验
4. `prev_events` / `auth_events` 可达性检查
5. state-before-event 计算
6. auth rules 判断
7. redaction / relation / state-key 规则处理
8. 落库并分配 `room_pos`
9. 更新 current state / extremities / snapshots
10. 生成 fanout 任务

### 14.3 State Resolution Strategy

`RoomDO` 必须提供显式的状态解析引擎：

* 输入：一组 extremities 对应的候选状态集
* 输出：当前 room version 规则下的 resolved state

实现要求：

* 使用 `RoomVersionStrategy` 调用版本化的 auth 与 state resolution 算法。
* 对已解析过的 extremity-set 结果进行 snapshot cache。
* 对长链和大 auth chain 进行分段处理，避免单次 CPU 爆炸。

### 14.4 Room Version Abstraction Layer

必须定义：

* `RoomVersionStrategy`
  * `validateEventShape`
  * `validateEventIdAndHash`
  * `authCheck`
  * `redactEvent`
  * `resolveState`
  * `supportsRestrictedJoin`
  * `supportsKnock`
  * `enforceCreationRules`

要求：

* 不允许在 `RoomDO` 业务代码中写 room version 分支散点逻辑。
* 新建房间默认使用 room version `12`。
* 架构上必须允许继续支持旧 stable room version；具体首发覆盖可按发布里程碑分阶段实现。

发布门槛建议：

* 本地非联邦里程碑可先以 room version `12` 为主完成闭环。
* 对外开放联邦前，至少完成 room version `11` 与 `12` 的稳定支持。

### 14.5 Hot / Warm / Cold Data Layout

为规避单 RoomDO `10 GB` 上限，必须分层：

* Hot
  * 当前 state
  * extremities
  * 最近 timeline JSON
  * membership projection
  * ephemerals
* Warm
  * 历史事件元数据
  * snapshot 链
  * 最近归档 manifest
* Cold
  * 老事件 canonical JSON
  * 老 snapshot materialization
  * 审计导出
  * 存放于 R2

规则：

* 冷化后仍保留恢复所需最小 metadata 于 RoomDO。
* D1 不是冷历史真相。

### 14.6 Local User Fanout

RoomDO 提交后不直接推 `/sync` 响应，而是生成“用户可见 delta”：

* 受影响的本地用户列表
* 每用户的 room delta 范围
* membership 变化
* 是否 limited
* 是否需要 device list 变化
* 是否需要 unread/push rule 重新计算

然后发送到对应 `UserDO`。

### 14.7 Ephemeral Room State

RoomDO 负责：

* typing 状态与过期
* receipt 当前值
* membership-derived 可见性判断辅助

规则：

* typing 通过 alarm 过期
* receipts 存最新值，不保存无限历史
* ephemeral 失败不影响房间权威 timeline

## 15. Federation Subsystem

### 15.1 Discovery and Delegation

联邦发现必须完全遵循 Matrix 服务器发现流程，不得简化为“域名直连 8448”。

实现要求：

* 支持 `/.well-known/matrix/server`
* 支持 `_matrix-fed._tcp` SRV
* 不依赖 Cloudflare 代理外的 `8448`
* 若使用 `/.well-known`，缓存策略遵循规范：
  * 尊重 Cache-Control
  * 默认可缓存 24h
  * 建议最大缓存 48h
  * 错误结果缓存上限 1h

Cloudflare 约束：

* 代理兼容的 HTTPS 端口默认是 `443` 和 `8443`，因此联邦入站必须围绕它们设计。

### 15.2 Signing and Key Management

本地服务器签名：

* 服务器 signing keys 存在 Worker secrets 或 Secrets Store。
* key material 永不进入代码仓库、`vars`、D1、KV。
* 支持多活 key set：
  * 当前 active key
  * 仍可验证历史事件的 retired keys

必须实现：

* `/_matrix/key/v2/server`
* 对 key 查询响应的正确签名
* 远端 key 获取与缓存

### 15.3 Inbound Transactions

联邦入站流程：

1. Worker 验证 TLS/Host/Authorization
2. 获取并验证远端签名 key
3. 在 `RemoteServerDO(origin)` 做 `txn_id` 去重
4. 分离 PDU 与 EDU
5. PDU 按 room 路由到 `RoomDO`
6. to-device / 设备类 EDU 路由到 `UserDO`
7. 必要时记录缺事件修复任务

规则：

* 入站事务的“收到”与“被房间接受”是两回事。
* 联邦事务成功响应表示事务被接收和处理，而不表示每个 PDU 都被作为当前 state/timeline 接受。

### 15.4 Outbound Transactions

`RemoteServerDO(server_name)` 负责所有出站事务：

* 按远端服务器线性化
* 生成 `txn_id`
* 打包 PDUs/EDUs
* 重试与退避
* 记录失败原因

要求：

* 重试时必须复用相同 `txn_id` 和相同 payload。
* payload 一旦排队不得在重试时追加更多事件。
* 发送并发受 Worker 每请求 `6` 个同时外连限制约束，单次 invocation 不得无界 fanout。

### 15.5 Backfill and Missing Event Recovery

`RoomDO` 在以下场景创建修复任务：

* 缺 `prev_events`
* 缺 `auth_events`
* 远端 join / invite / knock 所需 state 不完整
* 本地历史分页触达缺口

修复流程：

* `RoomDO` 生成 gap job
* `RemoteServerDO` 负责调度远端拉取：
  * `/event`
  * `/state`
  * `/state_ids`
  * `/backfill`
  * `/get_missing_events`
* 拉回事件重新进入 `RoomDO` 准入

### 15.6 Federation Retry Semantics

`RemoteServerDO` 使用以下重试策略：

* 幂等键：`server_name + txn_id`
* 初始快速重试
* 指数退避
* 上限后进入长周期 alarm 驱动
* 永不因为衍生错误而删除仍需发送的事务

### 15.7 Federation Media

本地媒体对联邦必须实现：

* `GET /_matrix/federation/v1/media/download/{mediaId}`
* `GET /_matrix/federation/v1/media/thumbnail/{mediaId}`

建议实现：

* 默认返回 `multipart/mixed`
* 第二段优先直接返回媒体字节，而不是外部重定向
* 仅在 operator 明确允许时才使用带时效 URL 的 redirect 模式

## 16. Media Subsystem

### 16.1 Upload Path

标准上传路径：

* `POST /_matrix/media/v3/upload`
* `POST /_matrix/media/v1/create`
* `PUT /_matrix/media/v3/upload/{serverName}/{mediaId}`
* `GET /_matrix/client/v1/media/config`

上传规则：

* `m.upload.size` 必须等于 `min(operator_config_limit, zone_body_limit)`。
* zone body limit 由 Cloudflare account/zone plan 决定，非 Workers Paid plan。
* Worker 必须流式写入 R2，不得整包缓冲。

当前 Cloudflare 文档给出的 HTTP request body 上限为：

* Free / Pro：`100 MB`
* Business：`200 MB`
* Enterprise：默认 `500 MB`

因此：

* 若产品要求标准 Matrix 客户端上传超过当前 zone limit 的文件，必须先提升 Cloudflare zone/account 能力。
* 不允许把非标准直传接口当作“已支持标准 Matrix 大文件上传”的依据。

`POST /create` 的职责：

* 由 `UserDO` 生成 pending MXC
* 记录 owner user
* 记录 `unused_expires_at`
* 对 pending uploads 做并发上限与速率限制

### 16.2 Download Path

下载路径：

* `/_matrix/client/v1/media/download/*`
* 兼容 `/_matrix/media/v3/download/*`

设计：

* 对本地媒体：
  * Worker 鉴权后直接从 R2 流式返回
* 对远端媒体：
  * 先查本地缓存
  * miss 时通过联邦媒体接口拉取并回填 R2

本地媒体下载的最小判断信息必须来自：

* 路径结构
* R2 对象存在性
* R2 对象 metadata

而不是强依赖 D1 查询结果。

### 16.3 Remote Media Cache

远端媒体缓存要求：

* cache key 为 `origin_server + media_id`
* 元数据存 D1
* 对同一远端媒体并发 miss 必须去重，避免重复拉取
* 远端拉取必须优先使用联邦媒体端点，必要时按规范 fallback

### 16.4 Thumbnail Strategy

缩略图策略：

* 本地缩略图是衍生对象，不是权威数据
* 缩略图存 R2
* 生成路径通过 Queue / jobs-worker 异步处理
* on-demand miss 可以触发同步生成，但要受 CPU/尺寸上限保护

约束：

* 超大原图必须返回 Matrix 规范要求的错误，而不是强行生成
* 支持 `animated=true` 时优先返回 `image/webp`；若不支持则退回静态图

### 16.5 Media Retention and Lifecycle

必须支持：

* 本地媒体保留策略
* 远端媒体缓存 TTL
* 冷媒体分级清理
* orphan media 清理

删除规则：

* 删除本地媒体后，要同步清理 D1 目录和缩略图对象
* 若未来对外使用 CDN cache 或 R2 custom domain，删除后必须配套 purge；当前推荐 Worker+R2 binding 直取以避免缓存陈旧

### 16.6 Media Config Endpoint

必须实现：

* `GET /_matrix/client/v1/media/config`

规则：

* 对客户端公布的 `m.upload.size` 必须反映真实 Cloudflare 可接受上限
* 当 zone/proxy 限制低于业务策略时，必须以下限对外声明
* 不允许宣称大于 Cloudflare 实际入站限制的上传能力

### 16.7 URL Preview Policy

`preview_url` 涉及 SSRF、隐私泄露、带宽滥用与恶意内容缓存。  
因此本 Spec 规定：

* 如实现 `preview_url`，必须走专用 fetch policy
* 必须阻断 RFC1918、link-local、metadata IP、回环地址与 operator denylist
* 必须限制响应大小、跳转次数、MIME 类型和抓取超时
* 必须做结果缓存和速率限制

若上述控制未完成，`preview_url` 默认关闭。

### 16.8 Matrix Compliance Notes

必须注意：

* `mxc://` URI 是权威标识，不得暴露 Cloudflare 内部对象路径为 canonical media id
* 不得要求标准 Matrix 客户端使用 Cloudflare 专有直接上传协议才能完成标准上传
* 非标准直传能力只能作为可选增强接口，不能替代 Matrix 标准上传

## 17. Search and Directory Subsystem

### 17.1 Search Scope

首版搜索范围：

* 房间消息正文
* sender
* 事件时间
* room filters

搜索是衍生能力：

* 可滞后
* 可重建
* 不影响房间权威提交

### 17.2 Indexing Pipeline

流水线：

1. `RoomDO` 提交事件
2. 发送 `search_index_event` Queue 消息
3. `jobs-worker` 解析并写入 D1 search shard
4. 唯一键为 `event_id`

### 17.3 User Directory

用户目录由 D1 派生：

* user profile
* 可见性策略
* 共房关系摘要

注意：

* 用户目录只读查询走 D1
* visibility policy 变化必须可重建

### 17.4 Public Rooms Directory

公共房间目录由 D1 派生：

* room_id
* canonical alias
* name/topic/avatar
* joined member count
* world_readable / public flags

### 17.5 Reindex Procedures

必须支持：

* 单房间重建
* 指定时间范围重建
* 全量重建

重建来源：

* 优先 RoomDO hot/warm 数据
* 历史超出热窗口时从 R2 archive segment 重放

## 18. Application Service Subsystem

### 18.1 Namespace Model

AS registration 必须包含：

* `id`
* `as_token`
* `hs_token`
* namespaces
* sender_localpart
* url
* rate-limited / exclusive flags

要求：

* `as_token` 和 `id` 全局唯一
* exclusive namespace 必须强制执行

### 18.2 Transaction Delivery

AS 推送必须遵循线性化事务模型：

* HS -> AS 事务按事件流顺序线性化
* 失败时用相同 `txnId` 重试
* 同一 `txnId` payload 不可变
* 不可达时指数退避

实现建议：

* 每个 AS 一个事务队列
* 幂等表以 `as_id + txn_id` 为键

### 18.3 Ping and Health Semantics

必须支持：

* AS ping
* 健康状态查询
* 暂停/恢复投递

### 18.4 Control Plane Storage

推荐：

* registration metadata 放 D1 control plane
* tokens 放 secrets
* 热缓存可放 KV，但变更后必须允许短 TTL 与强制刷新

## 19. Security Model

### 19.1 Authentication and Authorization

客户端鉴权：

* access token 由 `UserDO` 权威验证
* Worker 通过 token 中可路由信息定位到 `UserDO`
* `UserDO` 返回 user/device/session 身份

要求：

* token 不能放 KV 做权威校验
* token 比对必须基于 hash 存储
* logout / device deletion 后，`UserDO` 必须立刻使 session 失效

房间授权：

* 最终判定一律由 `RoomDO` + room version auth rules 执行

联邦授权：

* 按 Matrix 签名规范校验

### 19.2 Secret Material and Signing Keys

必须使用：

* Worker secrets 或 Secrets Store

严禁：

* 将敏感材料存入 `vars`
* 将私钥放进 D1 / KV / Git

密钥材料包括：

* homeserver signing key
* macaroon/JWT/HMAC root keys
* AS tokens
* 外部 push/SMTP/OTel 凭据

### 19.3 Abuse Resistance

必须实现：

* 登录/注册限速
* 媒体上传限速与 pending upload 上限
* 单用户/单设备请求速率限制
* 单房间发送速率限制
* 联邦入口事务大小和频率限制
* preview_url SSRF 保护

### 19.4 Multi-tenant Isolation

本 Spec 首版不支持单部署内多租户。  
因此隔离策略是：

* 每个 homeserver 域名独立部署
* 独立 secrets
* 独立 DO namespaces
* 独立 D1 / R2 / KV / Queues

## 20. Observability Model

### 20.1 Metrics

必须观测以下指标：

* Worker
  * request rate
  * CPU ms
  * wall time
  * auth failures
  * `/sync` active count
* DO
  * request rate per class
  * overload count
  * alarm retries
  * storage size growth
* D1
  * rows read/write
  * latency
  * overloaded errors
* R2
  * Class A/B ops
  * storage
  * cache hit/miss for remote media
* Queues
  * backlog
  * retry rate
  * DLQ volume

### 20.2 Logs

Workers Logs 必须启用结构化 JSON 日志。  
建议字段：

* `request_id`
* `route`
* `user_id`
* `device_id`
* `room_id`
* `remote_server`
* `event_id`
* `txn_id`
* `outcome`
* `latency_ms`
* `cf_ray`
* `worker_version`

成本控制：

* Workers Logs Paid 仅含 `20M` log events/月、保留 `7` 天
* 默认只对错误和关键事务 full log
* 正常请求按采样输出

### 20.3 Traces and Correlation

可选启用 OTel export。  
必须注意：

* OTel 导出当前支持 logs/traces，不支持指标导出
* 若只需要外部 sink，应考虑 `persist=false`，避免 Cloudflare 仪表盘留存计费

关联 ID 规则：

* 单请求生成 `request_id`
* 联邦事务附带 `txn_id`
* 房间事件附带 `event_id`
* 所有异步消息带 `causation_id`

### 20.4 Cost Observability

必须有月度成本面板，至少包含：

* Workers requests / CPU
* DO requests / duration / SQLite rows / storage
* D1 rows / storage
* R2 storage / Class A/B ops
* KV reads/writes
* Queue ops
* Workers Logs

## 21. Performance and Capacity Planning

### 21.1 Primary Load Drivers

主要负载驱动不是单一“消息数”，而是：

* 在线设备数
* `/sync` 并发数
* 房间局部热点
* 联邦 backfill 与缺事件修复
* 媒体带宽与对象数
* 搜索索引写入量

### 21.2 Single-Room Limits

单房间最终受制于单个 `RoomDO`：

* 单房间状态裁决无法横向拆成多个权威写者
* DO 单对象软上限约 `1000 req/s`

结论：

* 热门大房间必须被视为系统天然热点
* 需要对单房间发送、receipt、typing 做限流和聚合
* 大房间读多写少场景主要依赖 `/sync` 增量而不是直接打 `RoomDO` 历史查询

### 21.3 Online Device Scaling

* `/sync` 并发主要占 Worker wall time，而不是 CPU
* 每个在线设备至少对应一个挂起 `/sync`
* `UserDO` 只处理唤醒与用户流，不持有客户端 HTTP 请求

### 21.4 Search Scaling

* D1 单库单线程，搜索必须分 shard
* 推荐按 room hash / time partition 切 shard
* 搜索不允许成为事件提交阻塞点

### 21.5 Media Scaling

* R2 可横向扩展对象数和总容量
* Worker 只要流式处理，媒体下载不会受 response body size 限制
* 上传上限由 zone request body limit 决定

### 21.6 Sizing Guardrails

初始 guardrail 建议：

* 单用户设备数上限
* 单用户 pending upload 数上限
* 单房间 receipt/typing fanout 聚合窗口
* 单次联邦发送事件数与字节数上限
* 单次 `/sync` 输出事件数上限

## 22. Cost Model

### 22.1 Cost Components

成本项如下：

* Workers base plan、requests、CPU
* Durable Objects requests、duration、SQLite reads/writes/storage
* D1 rows/storage
* R2 storage/Class A/Class B
* KV reads/writes/storage
* Queues ops
* Workers Logs

### 22.2 Included Quotas and Overage Strategy

关键信息：

* Workers Paid：`$5/月`，含 `10M` requests、`30M` CPU ms
* DO：含 `1M` requests、`400,000 GB-s`
* DO SQLite：含 `25B` rows read、`50M` rows write、`5GB-month`
* D1：含 `25B` rows read、`50M` rows write、`5GB`
* R2：含 `10GB-month`、`1M` Class A、`10M` Class B
* KV：含 `10M` reads、`1M` writes、`1GB`
* Queues：含 `1M` ops
* Workers Logs：含 `20M` log events

策略：

* 任何新功能必须明确落到哪个计费面。
* `/sync` 设计优先消耗 Worker wall time，而不是 DO duration。
* 热路径避免不必要日志。

### 22.3 Low-scale, Mid-scale, High-scale Scenarios

低规模：

* 成本通常由基础 `$5` + 少量 DO / R2 / Logs 构成

中规模：

* `/sync`、DO requests、R2 storage 成为主要项

高规模：

* 热房间、联邦修复、搜索索引、日志采样不当会成为主要成本风险

### 22.4 Cost Guardrails

必须有以下 guardrail：

* `/sync` timeout 上限
* 日志采样率
* media retention policy
* remote media cache TTL
* search indexing backpressure
* AS / federation 重试风暴熔断

## 23. Deployment and Migration Strategy

### 23.1 Versioning Model

必须使用：

* 明确的 Worker versions / deployments
* staging -> canary -> prod 流程
* 显式 compatibility date

必须知道：

* Worker version 追踪代码与 bindings/config，但不追踪 D1/R2/DO/KV 实际数据状态

运维规则：

* 首次创建项目必须使用 `wrangler deploy`，不能直接 `versions upload`
* route/domain/cron 变更后必须执行 `wrangler triggers deploy`

### 23.2 Backward Compatibility Rules

所有 Worker <-> DO 接口必须：

* 前向兼容
* 后向兼容

原因：

* Cloudflare 对 Worker 与 DO 代码更新是全局最终一致发布
* 一段时间内新 Worker 可能调用旧 DO
* gradual deployment 会放大该窗口

### 23.3 Durable Object Schema Evolution

规则：

* 现有类代码更新不需要 migration，但必须兼容历史存储数据
* 新增/重命名/删除/转移 DO class 才使用 migration
* DO migration 必须单独发布
* migration 不能通过 `versions upload` 做渐进式上传

DO 内部 schema：

* 用 `schema_version` 表管理
* 构造函数只做轻量读和必要的同步升级
* 大型 backfill 不在 constructor 做

### 23.4 D1 Schema Evolution

D1 采用四阶段：

1. Additive schema
2. Dual write / backfill
3. Read switch
4. Cleanup

### 23.5 Rolling Upgrade Strategy

发布步骤：

1. 发布兼容代码
2. 观察错误率与关键指标
3. 执行非破坏性 backfill
4. 开启新开关
5. 清理旧字段/旧索引

DO migration 发布规则：

* 与普通代码变更分开
* blast radius 最小化
* 不使用 gradual deployment
* 使用 `wrangler deploy` 执行，而不是 `versions upload`

必须知道：

* 对同一个 Durable Object，在任一部署下同一对象实例只会运行一个版本
* gradual deployment 期间，不同对象实例可能被分配到不同版本
* 因此“对象间版本不一致”在 rollout 期间是正常现象，“同对象双版本并行”则不会发生

### 23.6 Version Affinity

对于 gradual deployment，建议：

* client 路由以 `user_id` 或 access token hash 做 version affinity
* federation 路由以 `server_name` 做 version affinity

目的：

* 降低同一用户/同一联邦对端在 rollout 期间的版本抖动

### 23.7 Secret Rotation and Deploy Coupling

Secrets 变更本质上也是 Worker 新版本的一部分。  
因此：

* 非渐进发布时使用 `wrangler secret put/delete`
* 渐进发布时使用 `wrangler versions secret put/delete`
* homeserver signing key、AS token、OTel credential 的变更都必须进入发布记录

## 24. Reliability and Recovery

### 24.1 Failure Modes

必须设计处理以下失败：

* Worker CPU / memory exceed
* Worker runtime update 中断请求
* DO overloaded
* DO restart / eviction / code update restart
* D1 overloaded
* Queue 重试堆积
* R2 或远端联邦超时
* 索引滞后

### 24.2 Replay and Rebuild Procedures

系统必须支持：

* 从 RoomDO + R2 archive 重建 D1 搜索/目录
* 从 UserDO 重建用户目录和设备投影
* 从 outbound queue 重建联邦发送状态

### 24.3 Disaster Recovery

Cloudflare 当前产品组合下，D1 有 time travel / restore，而 DO 权威状态没有同等内建 PITR。  
因此 DR 设计必须应用层补足：

* `RoomDO` 周期性向 R2 导出 room archive segment 与 state snapshot manifest
* `UserDO` 周期性导出设备/账户/密钥快照到 R2
* `ops-worker` 支持从 R2 export 重放到新 namespaces

要求：

* D1 不能被视为唯一恢复源
* R2 export 频率必须满足业务 RPO

### 24.4 Data Repair Workflows

必须支持的修复流程：

* 单 room graph repair
* 单 user device/keys repair
* 单 remote server txn queue repair
* remote media catalog repair
* search reindex

## 25. Testing Strategy

### 25.1 Unit and Property Testing

必须覆盖：

* room version auth rules
* state resolution
* token monotonicity
* one-time key “至多一次”
* transaction idempotency
* media metadata lifecycle

### 25.2 Protocol Compliance Testing

合规测试必须从规范条款直接构造：

* `/sync` initial / incremental / limited
* room create / join / leave / invite / knock
* federation send / backfill / state
* authenticated media download/upload
* AS transaction retries
* E2EE key query/claim/upload

现有社区测试套件可以作为补充回归，但不能作为规范来源。

### 25.3 Load Testing

必须单独压测：

* `/sync` 并发
* 热房间发送
* 远端媒体缓存 miss 风暴
* 联邦补事件风暴
* 搜索重建

### 25.4 Federation Chaos Testing

必须覆盖：

* 缺 `prev_events`
* 缺 `auth_events`
* 远端证书/密钥轮换
* `/.well-known` 失效与恢复
* 事务 ACK 丢失重试

### 25.5 Deployment Compatibility Testing

必须验证：

* 新 Worker 调用旧 DO
* 旧 Worker 调用新 DO
* gradual deployment 下用户流、房间流、联邦流不破坏
* deploy 时 wake WebSocket 断开后的 `/sync` 重试行为

## 26. Open Questions

以下问题不阻塞架构成立，但需要在 Sprint 0 / Sprint 1 通过 spike 固化：

1. `/sync` 首选唤醒通道采用 Worker <-> `UserDO` hibernation WebSocket；需做当前 runtime 组合验证与 soak test。
2. D1 搜索物理实现使用 SQLite FTS 还是归一化 token 表，应以当前 D1 SQLite 能力验证结果决定。
3. `preview_url` 的 SSRF 与隐私策略是否默认关闭或仅允许 allowlist，需要产品/安全共同定稿。
4. 是否引入 perspective/notary server 作为远端公钥增强来源，取决于联邦互操作风险评估。

## 27. Decision Log

1. `Worker` 持有 `/sync` 长轮询；`UserDO` 不持有 HTTP 长轮询。
2. `RoomDO(room_id)` 是房间权威状态机；D1 不承载房间状态真相。
3. `UserDO(user_id)` 是用户/设备/session/E2EE 权威状态机。
4. `RemoteServerDO(server_name)` 线性化联邦出站事务。
5. D1 只承担衍生查询面与控制面。
6. R2 负责媒体、冷历史、归档和灾备导出。
7. KV 只做缓存，不参与权威判断。
8. 联邦发现围绕 `443/8443` + `/.well-known` / SRV 设计，而不是默认 `8448`。
9. Worker 与 DO 接口强制前后兼容，原因是 Cloudflare 代码更新全局最终一致。
10. DO migrations 与普通代码发布解耦，单独执行。

## 28. Appendices

### 28.1 Terminology

* 权威状态：系统最终以其为准的状态
* 衍生状态：可由权威状态重建的查询面或缓存
* 用户流：`UserDO` 维护的用户视角 sync 增量流
* 房间流：`RoomDO` 维护的房间 timeline 序列
* 热数据：必须低延迟随机访问的数据
* 冷数据：仅用于分页、归档、审计、恢复的数据

### 28.2 Local Research Documents

* `research/notes/source-index.md`
* `research/notes/initial-research.md`
* `notes/matrix-cloudflare-feasibility.md`

### 28.3 Pricing and Estimation Tooling

* `matrix-price-calculator.html`

### 28.4 Suggested Repository Layout

```text
src/
  gateway/
    client_routes/
    federation_routes/
    media_routes/
    well_known/
  domain/
    auth/
    room_versions/
    sync/
    federation/
    media/
    appservice/
  do/
    user/
    room/
    remote_server/
  jobs/
    search_indexer/
    media_thumbnailer/
    archive_exporter/
    repair/
  storage/
    d1/
    r2/
    kv/
  ops/
    admin_api/
    export/
    repair/
tests/
  unit/
  property/
  integration/
  federation/
  load/
```

### 28.5 Recommended Delivery Milestones

建议里程碑：

1. `M0` Platform Spike
   * `/sync` wakeup path
   * RoomDO schema
   * media streaming to R2
   * deploy compatibility tests
2. `M1` Local Homeserver Core
   * auth
   * local rooms
   * `/sync`
   * media
   * E2EE transport
3. `M2` Federation Core
   * discovery
   * send/receive txn
   * room join/leave/invite over federation
   * missing event recovery
4. `M3` Enterprise Hardening
   * AS
   * search/directory
   * DR export/replay
   * cost guardrails
   * rollout automation
