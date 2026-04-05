# Observability, Performance, and Cost Spec

状态：Draft-Normative
角色：运营度量分册
负责主文档章节：5
继承的单体章节：20-22

## 1. 文档职责

* 定义指标、日志、追踪、相关性 ID 与成本观测模型。
* 定义负载驱动、容量边界、性能护栏、SLO/SLA 入口。
* 定义成本组件、额度消耗、超额策略与规模场景模型。

明确不包含：

* 不定义协议行为正文；
* 不定义部署与回放流程正文；
* 不替代财务预算系统。

## 2. 可观测性总原则

| REQ-ID | Requirement | Normative Statement |
| --- | --- | --- |
| `REQ-OPS-001` | Structured logs | 所有生产 Worker 必须输出结构化 JSON 日志。 |
| `REQ-OPS-002` | Correlation IDs | 每个请求、异步任务、联邦事务和运维作业都必须能关联到稳定 ID。 |
| `REQ-OPS-003` | Cost attribution | 每个主要成本面都必须有可观测指标与月度归因面板。 |
| `REQ-OPS-004` | Truth-path visibility | `UserDO`、`RoomDO`、`RemoteServerDO` 的核心提交路径必须有独立指标。 |
| `REQ-OPS-005` | Derived-lag visibility | D1/Queue/R2 派生滞后必须可测。 |

## 3. Metrics Model

### 3.1 必备指标字典

| Metric Family | Required Dimensions | Owner |
| --- | --- | --- |
| Worker requests / CPU / wall time / errors | worker, route family, status, version | `gateway-worker`,`jobs-worker`,`ops-worker` |
| `/sync` active waiters / wake latency / empty returns | environment, user cohort, worker version | `gateway-worker`,`UserDO` |
| `UserDO` requests / stream append rate / auth failures | class, shard key hash, method | `UserDO` |
| `RoomDO` requests / admission latency / soft-fail count / state-resolution cost | room cohort, room version, method | `RoomDO` |
| `RemoteServerDO` queue depth / retry count / backoff age | remote server, error class | `RemoteServerDO` |
| D1 reads / writes / latency / overload | database, query family | `jobs-worker`,`ops-worker` |
| R2 storage / Class A / Class B / remote media cache hit rate | bucket, object class | media subsystem |
| Queue backlog / retry / poison | queue name, consumer version | `jobs-worker` |
| Control-plane jobs / rebuild progress / export progress | job type, job id | `ops-worker` |

### 3.2 指标最小集合

* `worker.request.count`
* `worker.cpu_ms`
* `worker.wall_ms`
* `worker.error.count`
* `sync.waiter.active`
* `sync.wake.latency_ms`
* `userdo.stream.append.count`
* `roomdo.admission.latency_ms`
* `roomdo.state_resolution.count`
* `federation.outbound.queue_depth`
* `federation.retry.count`
* `d1.query.latency_ms`
* `r2.class_a.count`
* `r2.class_b.count`
* `queue.backlog.depth`

## 4. Logs Model

### 4.1 必备字段

| Field | Requirement |
| --- | --- |
| `request_id` | 每个公开请求唯一 |
| `causation_id` | 异步任务和重试链的因果 ID |
| `worker_name` / `worker_version` | 必备 |
| `route_family` | 必备 |
| `user_id` / `device_id` | 如适用 |
| `room_id` | 如适用 |
| `remote_server` / `txn_id` | 联邦场景必备 |
| `event_id` | 房间事件场景必备 |
| `outcome` / `errcode` / `error_class` | 必备 |
| `latency_ms` / `cpu_ms` | `latency_ms` 必备；`cpu_ms` 在 runtime 能提供真实 request-scope CPU 计时时必备，否则必须显式记录 `cpu_ms_unavailable = true`，不得伪造 wall time 充作 CPU |
| `cf_ray` | 如可得 |

### 4.2 日志约束

* 生产默认启用 Workers Logs。引用：`CF-WKR-015`。
* 正常高频请求必须采样，错误、控制面和恢复事件必须全量。
* 禁止记录 secrets、token 明文和敏感密钥材料。
* Workers Logs 只有 `7` 天保留期，只能作为短期运行遥测；控制面审计与恢复证据必须落到 `DATA-OPS-004` / `EVID-*`。引用：`CF-WKR-015`。
* 单条 Workers Logs 事件必须受平台 `256 KB` 单事件大小限制约束；超限被截断时，必须以平台提供的 `$cloudflare.truncated = true` 为权威信号，并映射到内部日志 schema，避免把截断日志当作完整证据。引用：`CF-WKR-015`。
* 当前 Workers `nodejs_compat` 只能保证一部分 Node.js API；若应用内 request telemetry 无法获取真实 request-scope CPU 计时，代码必须 fail-safe 并记录 `cpu_ms_unavailable = true`，而不是因 `process.*` helper 未实现把请求路径打成 `500`。引用：`CF-WKR-026`。

## 5. Traces and Correlation

### 5.1 相关性规则

* 所有公开请求都生成 `request_id`。
* 所有异步任务都生成 `job_id`，并携带上游 `causation_id`。
* 所有联邦事务都保留 `txn_id`。
* 所有恢复、回放、重建操作都保留 `job_id` 和 `operator_principal_id`。

### 5.2 OTel 导出

* 若启用 OTel export，必须明确是否把数据同时持久化到 Cloudflare dashboard。
* Cloudflare OTel `persist` 默认是 `true`；若只需要外部 sink，应设为 `false`。引用：`CF-WKR-018`。
* OTel export 当前只作为 logs/traces 出口，不替代 metrics 采集。引用：`CF-WKR-018`。
* tracing 的 included quota、overage price 与 retention 当前在 Cloudflare 文档间存在冲突；在 `OQ-0002` 关闭前，成本面板必须把 trace spans 与 log events 分开计量，禁止把任一数字硬编码为已澄清真相。引用：`CF-WKR-017`。

## 6. Cost Observability

### 6.1 月度成本面板必须覆盖

* Workers requests / CPU ms
* Workers Logs event volume
* DO requests / duration / SQLite rows / storage
* D1 rows / storage
* R2 storage / Class A / Class B
* KV reads / writes / deletes / list / storage
* Queue operations
* optional OTel export events
* production monthly snapshot 必须针对 Cloudflare account 的 latest closed billing period，而不是默认假设 previous calendar month。引用：`CF-WKR-029`,`CF-WKR-030`。

### 6.2 Included Quotas Matrix

`Included Quotas Matrix` 中的 Workers requests / CPU rows，只在 deployment 采用 Workers `Standard` usage model 时成立；若 deployment 使用其他 usage model 或合同计费，必须用相应合同事实替换。引用：`CF-WKR-019`。

| Cost Surface | Included Quota | CF IDs |
| --- | --- | --- |
| Workers requests | `10M / month` | `CF-WKR-019` |
| Workers CPU | `30M CPU ms / month` | `CF-WKR-019` |
| Workers Logs | `20M log events / month`, retention `7 days` | `CF-WKR-015` |
| DO requests | `1M / month`；计费单位定义见 `CF-DO-013` | `CF-DO-011`,`CF-DO-013` |
| DO duration | `400,000 GB-s / month` | `CF-DO-011` |
| DO SQLite rows | reads `25B / month`, writes `50M / month` | `CF-DO-012` |
| DO SQLite storage | `5 GB-month` | `CF-DO-012` |
| D1 rows | reads `25B / month`, writes `50M / month` | `CF-D1-006` |
| D1 storage | `5 GB` | `CF-D1-006` |
| R2 | storage `10 GB-month`, Class A `1M`, Class B `10M` | `CF-R2-005` |
| KV | reads `10M / month`, writes `1M / month`, deletes `1M / month`, list requests `1M / month`, storage `1 GB` | `CF-KV-003` |
| Queues | `1M ops / month` | `CF-QUE-001` |
| OTel export | tracing quota/pricing/retention currently unresolved across Cloudflare docs; keep trace spans and exported logs separately parameterized until `OQ-0002` closes | `CF-WKR-017`,`CF-WKR-018` |

### 6.3 Cost Model Rules

* 只有在 deployment 采用 Workers `Standard` usage model 时，Worker-to-Worker calls via Service Bindings 才不产生额外 Worker request fee；legacy `Bundled/Unbound` 必须把 caller 与 callee requests 分别计费；在 `Standard` 下，caller 与 callee 的 CPU 仍必须合并计费。引用：`CF-WKR-016`,`CF-WKR-009`。
* `/sync` 设计优先消耗 Worker wall time，而不是 DO duration。引用：`CF-WKR-001`,`CF-DO-009`,`CF-DO-011`。
* 媒体读取的主成本来自 R2 请求与存储，不来自 R2 Internet egress。引用：`CF-R2-003`,`CF-R2-005`。
* DO request 成本必须把 DO HTTP、顶层 RPC sessions、WebSocket 建连、入站 WebSocket messages 与 alarm invocations 一并建模，并按官方 transport-specific request unit 定义换算，不得只按 DO HTTP 入口估算。引用：`CF-DO-013`。
* Durable Objects WebSocket 的入站消息计费必须单独建模；其 request fee 按 `20:1` 折算为 billing requests。WebSocket 建连会形成 request，出站发送不会形成对等 DO request 计数，入站 protocol ping 不计入 websocket message requests，但这些路径仍会占用网络与 CPU 预算。引用：`CF-DO-013`。
* Queues 成本必须按 write / read / delete 三类操作分别计数，并按每 `64 KB` payload chunk 换算（`KB = 1000 bytes`）；每条消息还隐含约 `100` bytes 平台元数据；retry 会额外产生 read op，DLQ 写入会额外产生 write op，过期消息只产生 write+delete；batch 只改变吞吐与调用频率，不会把多条消息折叠成一次计费。引用：`CF-QUE-001`。
* 若为冷归档采用 R2 Infrequent Access，成本模型必须额外纳入 retrieval fee、`30` 天 minimum storage duration 与“无 included quota”的事实；默认 Included Quotas Matrix 只适用于 R2 Standard。引用：`CF-R2-005`。
* 当 deployment 启用 Cloudflare traces 或 OTel export 时，成本模型必须分别暴露 `trace_span_count`、`exported_log_event_count` 与 `persist_enabled`，并在 `OQ-0002` 关闭前禁止默认把 trace spans 自动并入 Workers Logs quota。引用：`CF-WKR-017`,`CF-WKR-018`。
* production monthly cost automation 若使用 Cloudflare Billing Usage API，必须先由官方 billing-cycle anchor 解析 latest closed billing period：优先使用 billing profile `next_bill_date`，若该字段在目标账号上缺失，则只允许退回到唯一的 account subscriptions `current_period_end`；并把该解析结果、对应官方 source URI、以及 raw bundle 中哪份 retained artifact / field selector 才是 anchor 证据一并编码进 `ProdCostSnapshot`。同时还必须消费当前 prod baseline `ProdInstallRecord`，证明 `billing_period.start` 严格晚于 `installed_at` 对应 UTC 日期。若 target account 不具备 Billing Usage API access，无法证明当前 query window 正对应 latest closed billing period，subscriptions 返回多个不一致 anchor，或窗口仍覆盖 pre-install spend，则必须 fail-closed。引用：`CF-WKR-029`,`CF-WKR-030`。

### 6.4 Pre-release Cost Proof Contract

* `TEST-COST-001` 的 pre-release half 不得再把 canonical file existence、local telemetry shim、或仅来自 `tests/local/*` 的 JSON 当作“actual cost proof”。
* pre-release cost proof 必须先执行一个 bounded workload，再对同一 pre-release environment 和同一 bounded workload window 查询 official Cloudflare metrics/billing surfaces，并将结果归一化为 [26-wire-schema-catalog.md](/root/Matrix/spec/framework/26-wire-schema-catalog.md) 中的 `PreReleaseCostObservation`。
* `PreReleaseCostObservation.cost_surfaces` 必须至少覆盖 `workers`,`durable_objects`,`d1`,`r2`,`kv`,`queues` 六个主要成本面；若启用 traces/OTel，还必须按 `OQ-0002` 的约束单独记录 `telemetry_export`，不得把 trace spans 默认并入 logs。
* `PreReleaseCostObservation.model_comparison` 必须显式输出 `status`,`summary`,`actual_total_usd`,`modeled_total_usd`,`drift_ratio`；若任一官方 surface、时间窗口或 usage-model 前提缺失，则必须 fail-closed，而不是用估算值补洞。
* `PreReleaseCostObservation` 只证明 pre-release bounded workload 的实际指标与模型比较；它不替代 production monthly `ProdCostSnapshotAttestation`，也不能关闭 `OQ-0002`。

## 7. Primary Load Drivers

* 在线设备数
* 活跃 `/sync` waiter 数
* 单房间热点写入
* 远端联邦恢复与 backfill
* 媒体对象量与远端 cache miss
* 搜索与目录派生滞后

## 8. Capacity and Sizing Guardrails

### 8.1 Hard/Soft Ceiling Awareness

* 单 `RoomDO` 或 `UserDO` 不得被当作无限扩展单元；Cloudflare 给出的单对象吞吐是软上限约 `1,000 req/s`。引用：`CF-DO-002`。
* 单个 Worker 请求必须受 `6` 个 simultaneous open connections 约束。引用：`CF-WKR-006`。
* 单个 D1 数据库必须被视为单线程资源。引用：`CF-D1-002`。

### 8.2 设计护栏

* 单 session 只允许一个活跃 `/sync` waiter。
* 单房间 typing/receipt 更新必须先聚合再 fanout。
* 远端媒体抓取与联邦拉取必须显式限并发。
* 搜索、目录和缩略图必须可延迟，不得阻塞真相面。

## 9. Performance Budgets

本分册定义的是预算方向，不是 SLA 承诺：

* 认证热路径应保持低 CPU、无外部网络等待。
* 本地非联邦房间发送应以单次 `RoomDO` 提交为主要时延来源，而不是 D1/R2/Queue。
* `/sync` 的“有事件后唤醒到返回”预算应优先优化 Worker 组装和房间投影，而不是长时间轮询频率。

具体数值门槛必须通过 `TEST-PERF-001`,`TEST-PERF-002` 压测固化到发布记录。

## 10. SLO / SLA Entry Points

进入 `L3` 前，至少必须定义以下 SLI：

* client request success rate
* `/sync` wake-to-response latency
* room event admission latency
* federation outbound success latency
* media upload/download success rate
* rebuild/recovery completion success rate

## 11. 运营度量域测试入口

| Area | TEST IDs | EVID IDs |
| --- | --- | --- |
| performance and capacity | `TEST-PERF-001`,`TEST-PERF-002` | `EVID-PERF-001` |
| cost model and quotas | `TEST-COST-001` | `EVID-COST-001` |
| deployment observability | `TEST-OPS-001` | `EVID-OPS-001` |

## 12. 完成标准

* 关键路径均有观测方案；
* 主要容量瓶颈有量化入口；
* 成本驱动可追溯到具体平台资源；
* 所有平台性成本/性能断言都已回链 `CF-ID` 与验证证据；
* 后续成本估算器和压测计划可直接引用本册。
