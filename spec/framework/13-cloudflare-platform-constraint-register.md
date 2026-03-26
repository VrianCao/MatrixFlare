# Cloudflare Platform Constraint Register

状态：Draft-Normative
角色：平台约束台账分册  
负责主文档章节：1，2，3，5  
扩展范围：全部 Cloudflare 平台依赖

## 1. 文档职责

* 记录所有会影响设计、实现、测试、成本或运营的 Cloudflare 平台事实。
* 把平台限制、平台行为、部署语义、计费维度从正文中抽离，建立唯一权威台账。
* 要求所有引用 Cloudflare 行为的分册都回链到本台账。

明确不包含：

* 不代替各责任分册做设计决策；
* 不代替成本分册做场景估算；
* 不代替外部官方文档本身。

## 2. 基线与使用规则

### 2.1 当前基线

* 当前平台假设：Cloudflare Workers Paid Plan。
* 计费 usage model 默认不预设为 `Standard` 或 legacy `Bundled/Unbound`；任何 request fee 结论都必须显式声明所依赖的 usage model。
* 当前来源基线：`research/sources/` 中的 Cloudflare 官方文档快照。
* 当前观察日期：`2026-03-26`。

### 2.2 使用规则

* 正文中任何 Cloudflare 数值、限制、行为都必须引用 `CF-ID`。
* 若某设计依赖未登记的 Cloudflare 特性，则该设计不能进入 `Draft-Normative`。
* 若 Cloudflare 官方事实变化，必须先更新本台账，再更新受影响正文。
* 本台账中的 “Design Impact” 只描述客观后果；具体实现决策仍由主责分册给出。
* `Official Source` 列使用逻辑 source key；对 Cloudflare 文档，默认解析到 `research/sources/cloudflare-<source-key>.md` 或 `research/sources/cloudflare-<source-key>.html`。
* 若某 `CF-ID` 的 `Official Source` 无法按上述规则解析到 pinned snapshot，则该条事实不得继续被视为可审计的 `Draft-Normative` 本地基线。

## 3. Workers 约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-WKR-001` | Workers | lifecycle | workers-limits | Paid | 入站 HTTP 请求在客户端保持连接期间没有固定 wall-time cap，但 runtime update / deployment / platform restart 仍可能中断 in-flight requests；Cloudflare 对此类中断给出的 grace period 是 `30s`。 | `/_matrix/client/v3/sync` 可以由 Worker 持有长轮询，但必须把平台中断视为正常早返回原因。 | `21`,`30`,`42` |
| `CF-WKR-002` | Workers | lifecycle | workers-limits | Paid | 客户端断开后，请求相关任务会被取消；`waitUntil()` 最多额外延长 `30s`。 | 长轮询、媒体转发、联邦拉取都必须把客户端断开视为正常终止原因。 | `21`,`30`,`32`,`33` |
| `CF-WKR-003` | Workers | limits | workers-limits | Paid | HTTP 请求 CPU time 默认 `30s`，可提升至 `5 min`。Queue consumer 与 DO alarm 的 wall time 上限为 `15 min`。 | 权威热路径必须远低于默认 CPU 上限；重建、缩略图、导出必须异步化。 | `13`,`21`,`30`,`31`,`33`,`42` |
| `CF-WKR-004` | Workers | limits | workers-limits | Paid | 每个 isolate 内存上限 `128 MB`。 | 媒体、归档、联邦大响应必须流式处理，禁止整包缓冲。 | `21`,`33`,`41` |
| `CF-WKR-005` | Workers | limits | workers-limits | Paid | 每次调用子请求默认上限 `10,000`，可配置提高，最高可达 `10M`。 | 不允许无界 fanout；`/sync`、联邦恢复、批量重建必须分片；压测和容量模型必须声明是否依赖提额配置。 | `21`,`30`,`31`,`32`,`41` |
| `CF-WKR-006` | Workers | limits | workers-limits | Paid | 每个顶层请求最多 `6` 个 simultaneous open connections；`fetch`、KV、Cache、R2、Queues、TCP sockets 与 outbound WebSocket 都受此预算约束；超出时新的连接尝试会被排队，停滞连接可能被 runtime 关闭。 | 远端媒体抓取、联邦并发拉取、R2/KV/Queues/网络 I/O 并发必须受控；若不再需要响应体，必须显式取消以释放连接头寸。 | `21`,`32`,`33`,`41` |
| `CF-WKR-007` | Workers | limits | workers-limits | Account/Zone | 请求体上限取决于 Cloudflare plan，而不是 Workers plan：Free/Pro `100 MB`，Business `200 MB`，Enterprise 默认 `500 MB`。 | `m.upload.size` 必须取业务配置与 zone plan 上限中的较小值。 | `13`,`21`,`33`,`41` |
| `CF-WKR-008` | Workers | limits | workers-limits | Paid | 压缩后 Worker bundle 上限 `10 MB`。 | 房间版本算法、媒体处理、搜索逻辑必须模块化，避免单 Worker 过胖。 | `21`,`31`,`33`,`34` |
| `CF-WKR-009` | Service Bindings | limits | service-bindings | Paid | 单个顶层请求最多 `32` 次 Worker invocations；每次 Service Binding 调用都会计入。 | Worker 切分可以做，但调用链必须浅，不能把内部 RPC 设计成多跳网格。 | `21`,`23` |
| `CF-WKR-010` | Service Bindings | limits | service-bindings, workers-limits | Paid | Service Binding 调用计入 subrequest limit，且单个顶层请求最多 `32` 次 Worker invocations；Service Binding 调用本身**不计入** simultaneous open connections，但由同一 top-level request 触发的全部 Worker 仍共享同一组 `6` 个 simultaneous open connections 预算。 | 内部 Worker 通信优先用 Service Binding，而不是公网 `fetch()`；容量规划必须同时受 subrequest / invocation 上限和共享的 `6` 连接预算约束，不得把拆分 Worker 当作扩大连接并发的手段。 | `21`,`23`,`41` |
| `CF-WKR-011` | Smart Placement | placement | workers-placement | Paid | Smart Placement 只影响 `fetch` handler，不影响 RPC methods 或 named entrypoints。 | `gateway-worker` 到 DO/Worker RPC 热路径不能依赖 Smart Placement 获得语义正确性。 | `21`,`23` |
| `CF-WKR-012` | Worker deployments | deployment | workers-versions-deployments | Paid | Worker 版本与部署是分离概念；新版本可先上传后再部署；单个 deployment 可同时承载 `1` 或 `2` 个 Worker versions。`wrangler versions upload` 不支持携带 Durable Object migrations；涉及 DO migration 时必须改用 `wrangler deploy`。 | 生产发布必须使用 versions/deployments，而不是隐式“每改即发”；任何跨请求签名 token 或兼容契约都必须容忍 rollout 期间的双版本并存；带 DO migration 的发布流程不能假设“先 upload 再 deploy”。 | `21`,`30`,`40`,`42` |
| `CF-WKR-013` | Workers Secrets | security | workers-secrets | Paid | Secrets 是加密绑定，Cloudflare 明确要求不要用 `vars` 存放敏感信息。 | 所有密钥、token、凭据都必须放入 secrets/Secrets Store。 | `40`,`42` |
| `CF-WKR-014` | Workers Secrets | deployment | workers-secrets | Paid | `wrangler secret put/delete` 会创建新 Worker version 并立即部署；渐进发布应改用 `wrangler versions secret put/delete`。 | secret rotation 必须纳入版本化部署流程。 | `40`,`42` |
| `CF-WKR-015` | Workers Logs | billing/retention | workers-pricing, workers-logs | Paid | Workers Logs 含 `20M` log events/月，保留 `7` 天；单条日志最大 `256 KB`，超限会被截断，并由平台把 `$cloudflare.truncated` 设为 `true`。 | 生产必须设计日志采样、摘要化与截断识别策略；应用与证据管道不得把被截断事件当作完整记录。 | `41` |
| `CF-WKR-016` | Service Bindings | billing | workers-pricing | Paid under Standard pricing | 只有在 Workers `Standard` usage model 下，经 Service Binding 调用另一 Worker 才不产生额外 Worker request fee；legacy `Bundled/Unbound` 不适用；在 `Standard` 下，计费 CPU 是 caller 与 callee 的总 CPU 时间。 | 任何成本模型只要用到 Service Binding request fee 优惠，都必须先声明 deployment 采用 `Standard` usage model，并把调用链上的总 CPU 一并计费。 | `21`,`41` |
| `CF-WKR-017` | OpenTelemetry | billing | workers-opentelemetry | Paid | OTel 导出 logs/traces 各含 `10M` events/月，超额按量计费。 | 启用 OTel 时必须进入成本面板。 | `41` |
| `CF-WKR-018` | OpenTelemetry | behavior | workers-opentelemetry | Paid | OTel export `persist` 默认为 `true`，会同时导出并存入 Cloudflare dashboard；可设 `false` 仅发外部 sink。 | 必须显式决定是否接受双重留存与相应计费。 | `41` |
| `CF-WKR-019` | Workers | billing | workers-pricing | Paid under Standard pricing | 在 Workers `Standard` usage model 下，Workers Paid 基础费 `$5/月`，含 `10M` requests/月 与 `30M` CPU ms/月。 | 任何使用该包含量的成本估算都必须先声明 deployment 采用 `Standard` usage model，再做抵扣。 | `41` |
| `CF-WKR-020` | Workers | limits | workers-limits | Paid | 单个 environment variable / secret value 大小上限 `5 KB`。 | 任何以 secret 形式注入 Worker 的活跃 keyring、签名根映射或其他安全配置都必须受 `5 KB` 上限约束；若超限，必须改用 Secrets Store 或拆分为多个 versioned secrets。 | `21`,`24`,`30`,`40`,`42` |
| `CF-WKR-021` | Workers Secrets | scope | workers-secrets | Paid | 默认 secrets 作用域是单个 Worker project / environment；若要跨多个 Worker 复用同一敏感材料，必须显式重复配置，或改用 account-level Secrets Store binding。 | 默认设计应避免多 Worker 共享同一 secret；若确需共享，必须把共享策略写进部署与轮换流程，不能依赖“另一个 Worker 自然可见”。 | `21`,`30`,`40`,`42` |
| `CF-WKR-022` | Workers | limits | workers-limits | Paid | 单个 Worker 最多 `128` 个 environment variables（secrets + text variables）。 | 通过“拆分为多个 secrets”规避 `5 KB` 单值上限时，仍必须受总数上限约束；key rotation 与双版本并存设计不得假设 secrets 数量无限。 | `21`,`40`,`42` |
| `CF-WKR-023` | Workers RPC / Service Bindings RPC / Durable Object RPC | limits | workers-rpc, do-rpc-stubs | Paid | 普通 serialized RPC message 的 hard ceiling 为 `32 MiB`；更大传输必须改用 stream-based transfer，而不是单条序列化消息。Durable Object method-call RPC 需按 DO stubs 指南回链到 Workers RPC 文档理解该 transport 约束。 | 所有内部 Worker/DO RPC 契约都必须分页、分段或改为 stream / R2 locator 设计；不得把大房间投影、导出段或审计结果一次性塞进单个 RPC 返回值。 | `21`,`23`,`26`,`30`,`31`,`32`,`42` |

## 4. Durable Objects 约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-DO-001` | Durable Objects | concurrency | do-limits | Paid | 每个 Durable Object 实例天然单线程。 | `RoomDO`、`UserDO`、`RemoteServerDO` 可作为主权串行状态机。 | `21`,`22`,`30`,`31`,`32` |
| `CF-DO-002` | Durable Objects | throughput | do-limits | Paid | 单对象软上限约 `1,000 req/s`。 | 不能把高热点全局状态塞入单个 DO；必须按 `room_id`、`user_id`、`server_name` 分片。 | `21`,`31`,`32`,`41` |
| `CF-DO-003` | Durable Objects | storage | do-limits | Paid | SQLite-backed DO 单对象存储上限 `10 GB`。 | 房间历史、媒体目录、导出必须分层，RoomDO 需要冷热拆分。 | `21`,`22`,`31`,`33`,`42` |
| `CF-DO-004` | Durable Objects | lifecycle | do-lifecycle | Paid | DO 可因空闲、部署或运行时决策被驱逐；不提供 shutdown hook。 | 所有关键状态必须增量写入，不允许依赖关停时 flush。 | `21`,`22`,`31`,`32`,`42` |
| `CF-DO-005` | Durable Objects | deployment | do-known-issues, do-lifecycle | Paid | Worker 与 DO 代码更新是全局最终一致发布，短时间内会出现新 Worker 调旧 DO 版本。 | Worker/DO 接口必须前后兼容；迁移必须与普通发布解耦。 | `21`,`23`,`42` |
| `CF-DO-006` | Durable Objects | deployment | workers-gradual-deployments, do-migrations | Paid | DO migrations 是原子操作，不能渐进发布。 | 迁移必须独立发布；代码版本必须先兼容目标 schema。 | `21`,`24`,`42` |
| `CF-DO-007` | Durable Objects SQLite | consistency | do-sqlite-storage-api | Paid | SQLite 存储在 DO 内提供事务性、强一致本地状态。 | 权威真相应优先放在 DO SQLite，而不是 D1/KV。 | `21`,`22`,`24`,`30`,`31`,`32` |
| `CF-DO-008` | Durable Objects SQLite | memory/backpressure | do-sqlite-storage-api | Paid | 持续大量 `put()` 而不等待 I/O 会积累写缓冲并可能触发内存压力。 | 大批量写入和重建必须显式分批并在需要时 `await` 以施加背压。 | `21`,`31`,`32`,`42` |
| `CF-DO-009` | Durable Objects WebSocket | lifecycle/billing | do-websockets, do-pricing | Paid | Hibernation WebSocket 在空闲时不计 DO duration；普通 `accept()` 持有连接会持续计费。 | 唤醒通道必须使用 DO WebSocket Hibernation API，而不是常驻活跃 DO 连接。 | `21`,`30`,`41` |
| `CF-DO-010` | Durable Objects WebSocket | deployment | do-websockets | Paid | 部署新版本会断开 DO 持有的 WebSocket。 | `/sync` 唤醒通道断开必须被视为正常短暂事件，不得破坏 token 语义。 | `21`,`30`,`42` |
| `CF-DO-011` | Durable Objects | billing | do-pricing | Paid | DO 含 requests `1M/月` 与 duration `400,000 GB-s/月`。 | 任何 DO 成本估算都必须先抵扣包含量，并避免把长等待放在非 hibernating DO 上。 | `41` |
| `CF-DO-012` | Durable Objects SQLite | billing | do-pricing | Paid | SQLite-backed DO 含 rows reads `25B/月`、rows writes `50M/月`、stored data `5 GB-month`。 | DO truth schema 与批处理策略必须考虑读写和存储预算。 | `41` |
| `CF-DO-013` | Durable Objects | billing semantics | do-pricing | Paid | DO request 计费面不仅包含 DO HTTP requests，还包含 RPC sessions、WebSocket messages 与 alarm invocations；每次顶层 DO stub RPC method call 计为一个 billed RPC session，但返回 `RpcTarget` 后在同一 session 上继续调用不额外计费；入站 WebSocket messages 仅按 `20:1` 折算为 billing request，出站 WebSocket messages 不计 DO requests，入站 WebSocket protocol pings 也不计入 websocket message requests。 | 成本模型必须把 DO HTTP、顶层 RPC session、WebSocket 建连、入站 WebSocket message 与 alarm 触发量分别建模，不得把“所有 RPC 调用”等价成同一种 request unit。 | `21`,`30`,`32`,`41` |
| `CF-DO-014` | Durable Objects | known issue / uniqueness | do-known-issues | Paid | DO global uniqueness 在“开始新事件”和“访问 durable storage”时强制；若事件运行较久且从未访问 durable storage，则对象可能已不再 current。此时若晚些再访问 storage 会抛异常；若始终不访问 storage，事件可能静默完成但已失去全局唯一性保证。 | 所有权威处理路径都必须在 handler 早期触碰 durable storage 以强制 currentness；不得把长时间只靠内存的 authority logic 视为安全的单实例串行路径。 | `21`,`22`,`30`,`31`,`32`,`42` |
| `CF-DO-015` | Durable Objects SQLite | limits | do-limits | Paid | SQLite-backed DO 的 key + value combined size 不得超过 `2 MB`；SQL string/BLOB/table row size 也受 `2 MB` ceiling 约束。 | 事件 JSON、state snapshot、去重缓存与恢复暂存行都必须逻辑分片；DO storage rows 不能被当作无界 blob。 | `21`,`30`,`31`,`32`,`42` |
| `CF-DO-016` | Durable Objects SQLite | limits | do-limits | Paid | 单条 SQL statement length 上限 `100 KB`。 | backfill、repair、导出与批量 upsert 必须受 statement size 约束并显式分批，禁止生成巨型 SQL。 | `21`,`31`,`32`,`42` |
| `CF-DO-017` | Durable Objects WebSocket | limits | do-limits | Paid | DO 接收的单条 WebSocket message 大小上限为 `32 MiB`；该限制只针对 received messages。 | `/sync` 唤醒通道、运维长连接与任何 DO WebSocket 协议都必须限制入站消息大小；更大 payload 必须拆帧、分块或改走其他传输。 | `21`,`30`,`41` |
| `CF-DO-018` | Durable Objects / Workers runtime | limits | do-limits, workers-limits | Paid | Durable Objects 运行在 Workers runtime 上；per-isolate memory hard ceiling 为 `128 MB`。 | state resolution、恢复、导出装配与大房间查询都必须流式化或分段；DO authority path 不得依赖大内存整包缓冲。 | `21`,`31`,`32`,`42` |

## 5. D1 约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-D1-001` | D1 | capacity | d1-limits | Paid | 单数据库最大 `10 GB`。 | 搜索、目录、控制面数据必须支持分库或可重建。 | `21`,`22`,`34`,`41` |
| `CF-D1-002` | D1 | concurrency | d1-limits | Paid | 每个 D1 数据库天然单线程，一次只处理一个查询。 | 不得把高写入权威路径设计到单库 D1。 | `21`,`22`,`34`,`41` |
| `CF-D1-003` | D1 | consistency | d1-read-replication | Paid | 读副本异步复制，任意时刻都可能落后于主库。 | 目录和搜索默认接受最终一致；需要读到已写结果时必须使用 Sessions API。 | `22`,`34` |
| `CF-D1-004` | D1 Sessions API | consistency | d1-read-replication | Paid | Sessions API 可为单逻辑会话提供 sequential consistency。 | 对需要连续读写一致的派生查询必须显式传递 session/bookmark。 | `22`,`23`,`34` |
| `CF-D1-005` | D1 | recovery | d1-limits | Paid | D1 Time Travel / point-in-time recovery 在 Workers Paid 上保留 `30` 天。 | D1 可作为派生面恢复加速器，但不能替代 DO truth exports。 | `42` |
| `CF-D1-006` | D1 | billing | d1-pricing | Paid | D1 含 reads `25B/月`、writes `50M/月`、storage `5GB`。 | 搜索和目录的预算模型必须先抵扣包含量。 | `41` |
| `CF-D1-007` | D1 | limits | d1-limits | Paid | 单次 Worker invocation 内最多执行 `1,000` 条 D1 queries。 | rebuild、search backfill 与控制面批处理必须显式分批，不能把大作业写成单 invocation 无界循环。 | `21`,`34`,`41`,`42` |
| `CF-D1-008` | D1 | limits | d1-limits | Paid | 单条 SQL query 最长执行时间 `30s`。 | 目录 rebuild、审计查询与控制面报告必须避免超长 SQL；必要时拆成分页或多阶段 job。 | `34`,`41`,`42` |
| `CF-D1-009` | D1 | limits | d1-limits | Paid | 每次 Worker invocation 最多同时打开 `6` 个到 D1 的连接。 | 任一把 D1 混入公开请求热路径、重建作业或多路派生查询的实现，都必须把 D1 连接并发显式纳入连接预算。 | `21`,`41`,`42` |

## 6. KV 约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-KV-001` | KV | consistency | kv-how-it-works | Paid | KV 是最终一致的；跨地域可见性可能延迟 `60s` 或更久。 | KV 不能承载会话撤销、房间状态、媒体存在性、联邦幂等等强一致路径。 | `21`,`22`,`30`,`31`,`32`,`33` |
| `CF-KV-002` | KV | consistency | kv-how-it-works | Paid | negative lookups 也会被缓存。 | 不得把 KV 中的“不存在”作为权威结论。 | `21`,`22`,`32`,`33` |
| `CF-KV-003` | KV | billing | workers-pricing | Paid | Workers KV 含 reads `10M/月`、writes `1M/月`、deletes `1M/月`、list requests `1M/月`、storage `1 GB`。 | 任何 KV 使用都必须被视为有限缓存预算；失效、扫描和批量清理同样要进入成本模型。 | `41` |

## 7. R2 约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-R2-001` | R2 | consistency | r2-consistency | Paid | R2 对对象写、读、删、列举都是强一致；写后全局立即可见。 | 本地媒体对象、缩略图、归档可直接依赖 R2 作为对象真相。 | `21`,`22`,`33`,`42` |
| `CF-R2-002` | R2 | limits | r2-limits | Paid | 单次 single-part 上传上限 `5 GiB`；multipart 总对象可达 `4.995 TiB`。 | 标准 Matrix 上传只能通过 Worker 接入时，仍受 zone request body 限制。 | `21`,`33`,`41` |
| `CF-R2-003` | R2 | pricing | r2-pricing | Paid | 通过 Workers API、S3 API、`r2.dev` 直取 R2 不收 Internet egress 费。 | 媒体读取主成本来自请求与存储，而不是 R2 对外带宽。 | `33`,`41` |
| `CF-R2-004` | R2 + CDN | caching | r2-consistency | Paid | 若通过带缓存的域名公开对象，删除后缓存副本可能仍可见，需显式 purge。 | 认证媒体与远端缓存媒体不应依赖公共缓存域名作为唯一出口。 | `33`,`40` |
| `CF-R2-005` | R2 | billing | r2-pricing | Paid | R2 Standard 含 storage `10 GB-month`、Class A `1M/月`、Class B `10M/月`；若使用 Infrequent Access，则无对应 included quota，并有 retrieval fee 与 `30` 天 minimum storage duration。 | 媒体和归档成本模型必须先区分 Standard 与 IA，再决定是否能使用包含量抵扣。 | `41` |

## 8. Queues 约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-QUE-001` | Queues | billing | queues-pricing | Paid | 标准操作每月含 `1,000,000` 次，超额按量计费；write/read/delete 都单独计数，并按每 `64 KB` payload chunk 计费（`KB = 1000 bytes`）。每条消息约含 `100` bytes 平台内部元数据；retry 会额外产生 read op；写入 DLQ 会额外产生 write op；过期未消费消息只产生 write+delete。 | 队列仅用于衍生与补偿工作，不能滥用作同步控制总线；batch 不能被当作“单次计费”假设；接近 `64 KB` 的 payload、重试风暴与 DLQ 设计都必须单独进入成本模型。 | `21`,`34`,`41` |
| `CF-QUE-002` | Queues | runtime | workers-limits | Paid | Queue consumer 单次 wall time 上限 `15 min`。 | 重建、导出、缩略图任务必须可断点续跑。 | `21`,`33`,`34`,`42` |
| `CF-QUE-003` | Queues | retention | queues-pricing | Paid | Message retention 默认 `4` 天，可配置到 `14` 天。 | 长期恢复或重建不允许只依赖 Queue 本身保留。 | `42` |

## 9. 网络与暴露约束

| CF-ID | Product | Category | Official Source | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CF-NET-001` | Edge Network | ports | network-ports | Zone | Cloudflare 代理支持 HTTPS `443` 与 `8443` 等端口；`8448` 不在标准代理 HTTPS 端口列表中。 | Matrix 联邦发现不能假设入站走 `8448`，必须支持 `443`/`8443` + `/.well-known`/SRV。 | `21`,`32` |
| `CF-NET-002` | Edge Network | ports/cache | network-ports | Zone | `8443` 等额外 HTTPS 端口默认禁用缓存。 | 若使用 `8443` 承载联邦，不影响正确性，但不能把缓存特性作为前提。 | `32`,`33` |
| `CF-NET-003` | Cloudflare Access | compatibility | access-application-paths | Zone | Access application paths 不支持 URL 端口；若请求 URL 含端口，Access 会去掉该端口并重定向到默认 HTTP/HTTPS 端口。 | 内部运维入口若用 Access，不能依赖端口区分应用。 | `21`,`42` |
| `CF-NET-004` | Cloudflare Access | request identity propagation | access-validate-jwt | Zone | 通过 Access 成功鉴权后，请求到达 origin/Worker 时会带 `Cf-Access-Jwt-Assertion` 头；浏览器流量还可能带 `CF_Authorization` cookie，但 cookie 不保证总会传递。 | 应用层身份校验必须首选 `Cf-Access-Jwt-Assertion`，不得只信任 cookie 或展示性注入头。 | `40`,`42` |
| `CF-NET-005` | Cloudflare Access | signing keys | access-validate-jwt | Zone | Access JWT 必须使用 team domain 的 `/cdn-cgi/access/certs` JWK/cert 集校验；签名 key 默认约每 `6` 周轮换，旧 key 约保留 `7` 天；必须按 JWT `kid` 选择匹配 key，而不是钉死单一当前证书。 | `ops-worker` 必须实现 JWK 集缓存、`kid` 命中与轮换容忍，且在无匹配有效 key 时 fail-closed。 | `40`,`42` |
| `CF-NET-006` | Cloudflare Access | service tokens | access-service-tokens | Zone | Access service token 是发给 Access 边缘的 `Client ID + Client Secret` 凭据；在 service-auth only 应用中，调用方通常需要在每次请求继续发送该凭据给 Access。origin/Worker 应信任 Access 生成并注入的 JWT，而不是直接把 service-token headers 当作应用层 bearer secret。 | 运维自动化必须把 service token 视为 Access ingress credential；`ops-worker` 的应用层授权只基于已验证 JWT 与内部 authz policy。 | `40`,`42` |

## 10. 规范性设计结论

* `gateway-worker` 可以安全持有 `/sync` 长轮询，但不得在连接断开后继续依赖原请求上下文。引用：`CF-WKR-001`,`CF-WKR-002`。
* 所有权威真相必须落在以 DO SQLite 为核心的主权对象中，D1/KV 只能承担衍生或缓存角色。引用：`CF-DO-001`,`CF-DO-007`,`CF-D1-002`,`CF-KV-001`。
* 所有 Worker/DO 内部接口都必须前后兼容，并为 DO migration 单独建立发布与回滚流程。引用：`CF-DO-005`,`CF-DO-006`,`CF-WKR-012`。
* 所有 Worker-to-Worker 与 Worker-to-DO 的普通 RPC 契约都必须受 `32 MiB` serialized payload ceiling 约束；若可能超限，必须改为 stream 或 locator 模式。引用：`CF-WKR-023`。
* 所有媒体上传能力都必须同时受 Matrix 协议能力声明和 Cloudflare zone request body 限制约束。引用：`CF-WKR-007`,`CF-R2-002`。
* 所有 DO truth / repair / export 设计都必须同时尊重 `2 MB` row/value ceiling、`100 KB` SQL statement ceiling、`32 MiB` received WebSocket ceiling 与 `128 MB` runtime memory ceiling。引用：`CF-DO-015`,`CF-DO-016`,`CF-DO-017`,`CF-DO-018`。
* 所有通过 Cloudflare Access 保护的管理面都必须以 `Cf-Access-Jwt-Assertion` 为应用层身份源，并实现 JWK 轮换容忍；service token 只用于 Access 边缘鉴权，不是 origin 侧长期 bearer secret。引用：`CF-NET-004`,`CF-NET-005`,`CF-NET-006`。
* 所有主权 DO 的 authority handler 都必须在早期强制 currentness；不得把“未触碰 durable storage 的长运行事件”当作仍受全局唯一性保证的安全路径。引用：`CF-DO-014`。

## 11. 完成标准

* Cloudflare 设计相关事实均已挂账；
* 每条事实都能定位到受影响分册与组件；
* 成本、性能、部署、恢复问题都能回链到平台事实；
* 可直接作为 Cloudflare 贴合性审查基线。
