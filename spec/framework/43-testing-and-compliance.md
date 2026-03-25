# Testing and Compliance Spec

状态：Draft-Normative
角色：验证分册
负责主文档章节：7
继承的单体章节：25

## 1. 文档职责

* 定义单元、属性、集成、协议合规、负载、混沌、部署兼容测试框架。
* 定义规范覆盖矩阵、门禁、通过标准与发布验收条件。
* 定义测试环境、模拟依赖、回归策略与证据产出。

明确不包含：

* 不定义具体业务正文；
* 不定义成本预算正文；
* 不替代 CI/CD 实施文档。

## 2. 测试环境分层

| Environment | Purpose |
| --- | --- |
| local | 单元、属性、纯算法测试 |
| CI integration | Worker/DO/R2/D1/KV/Queue 集成回归 |
| staging | 协议与端到端回归 |
| pre-release | canary、版本偏斜、性能、恢复演练 |
| periodic drill | 定期恢复与成本审计 |

## 3. Test Catalog

| TEST-ID | Test Scope | Environment | Gate Profiles | Notes |
| --- | --- | --- | --- | --- |
| `TEST-GOV-001` | source baseline, traceability, ID integrity lint | CI | `L1-L3` | 校验 `REQ/MX/CF/IF/DATA/FLOW/STATE/TEST/EVID` 链接完整性、无未登记引用、无 compatibility page 误用为权威正文。 |
| `TEST-CS-001` | discovery, capabilities, registration, login, refresh, logout, profile surfaces and profile propagation basics | CI + staging | `L1-L3` | 必须覆盖 `/capabilities`、profile `keyName` 语义与 profile change propagation 基线。 |
| `TEST-CS-002` | filter lifecycle, `/sync` initial/incremental/limited/`full_state`/`use_state_after`, `include_leave`, lazy-load members, account data, push rules, and notification counts | CI + staging | `L1-L3` | 重点验证 token 单调性、filter determinism、leave-room visibility、member lazy-load 以及通知计数语义。 |
| `TEST-CS-003` | devices, to-device, key upload/query/claim, backup metadata | CI + staging | `L1-L3` | 必须验证 one-time key at-most-once。 |
| `TEST-ROOM-001` | room creation, membership, event send, redaction, receipts, typing | CI + staging | `L1-L3` | 房间核心行为。 |
| `TEST-ROOM-002` | enabled room version strategy compatibility | CI + staging | `L1-L3` | `L1` 至少覆盖 room version `12`；`L2-L3` 必须覆盖 `11` / `12` 差异，包括 redaction 与 state resolution。 |
| `TEST-FED-001` | federation discovery, key retrieval, request authentication, and query-surface auth/routing | staging | `L2-L3` | 必须覆盖 `/.well-known` / SRV / direct host paths，以及 `IF-FED-006`。 |
| `TEST-FED-002` | inbound/outbound txn idempotency and join/leave/knock flows | staging | `L2-L3` | 验证 per-server ordering。 |
| `TEST-FED-003` | missing event recovery, backfill, gap repair chaos | pre-release | `L2-L3` | 必须覆盖缺 `prev_events` / `auth_events`。 |
| `TEST-MEDIA-001` | local upload/download/thumbnail/quota | CI + staging | `L1-L3` | 必须验证 streaming 与 body limit handling。 |
| `TEST-MEDIA-002` | remote media cache, timeout, retry, cache eviction | staging | `L2-L3` | 受连接上限约束。 |
| `TEST-DER-001` | search, user directory, public rooms derived consistency | CI + staging | `L1-L3` | 验证派生索引正确性与 rebuild 后一致性。 |
| `TEST-AS-001` | appservice namespace, query, transaction delivery and retry | staging | `L3 when enabled` | appservice 开启时才进入门禁。 |
| `TEST-SEC-001` | token revocation, secret handling, federation auth failures | CI + staging | `L1-L3` | 重点验证 auth invalidation 与 secret boundaries。 |
| `TEST-SEC-002` | abuse resistance, rate limits, SSRF and quota guards | staging + pre-release | `L3` | URL preview 启用时必须额外覆盖。 |
| `TEST-OPS-001` | new Worker -> old DO and old Worker -> new DO compatibility | staging + pre-release | `L1-L3` | 版本偏斜门禁。 |
| `TEST-OPS-002` | replay, rebuild, export, restore, scoped repair | pre-release + periodic drill | `L3` | 恢复门禁。 |
| `TEST-PERF-001` | `/sync` concurrency and online device scaling | pre-release | `L3` | 重点看 Worker wall time、wake latency。 |
| `TEST-PERF-002` | hot room send / receipt / typing / derived lag | pre-release | `L3` | 重点看单房间热点；`L2` 可选执行但不构成 release gate。 |
| `TEST-COST-001` | quota accounting and budget guardrail validation | monthly + pre-release | `L1-L3` | 对比实际指标与定价模型。 |

## 4. Unit and Property Testing

必须覆盖：

* room version auth rules
* state resolution
* sync token monotonicity
* one-time key at-most-once
* transaction idempotency
* media metadata lifecycle

属性测试必须优先用于：

* room DAG / state resolution 输入组合
* token/stream 游标单调性
* retry/backoff 状态机

## 5. Integration and End-to-End Testing

* 必须在接近 Cloudflare 真实拓扑的环境中验证 Worker、DO、R2、D1、KV、Queues。
* 任何只在内存 mock 上通过的结论，不得作为发布门禁证据。
* staging 必须至少包含：
  * Worker versions/deployments
  * 真正的 DO namespace
  * D1
  * R2
  * Queues

## 6. Protocol Compliance Testing

* 所有协议合规测试必须直接从 Matrix `v1.17` versioned spec 生成。
* 社区测试套件可以作为补充回归，但不能作为规范来源。
* 对每个 `Required-Core` `MX-ID`，至少必须有一个 `TEST-ID` 和一个 `EVID-ID`。
* push-rules 合规测试必须把运行时生成的 server-default baseline 与 [92-appendices.md](/root/Matrix/spec/framework/92-appendices.md) 中钉死的 `v1.17` 基线逐条比对，至少覆盖 `kind`、顺序、`rule_id`、`enabled`、conditions 和 actions。

## 7. Load, Capacity, and Chaos Testing

### 7.1 必测压测场景

* `/sync` 并发
* 热房间发送
* 联邦补事件风暴
* 远端媒体 cache miss 风暴
* 搜索重建

### 7.2 联邦混沌场景

* 缺 `prev_events`
* 缺 `auth_events`
* `/.well-known` 失效与恢复
* 远端 key 轮换
* 事务 ACK 丢失与重试

## 8. Deployment Compatibility Testing

* 必须验证新 Worker 调旧 DO。
* 必须验证旧 Worker 调新 DO。
* 必须验证 gradual deployment 期间 `/sync`、房间写入、联邦发送不破坏语义。
* 必须验证 deploy 时 DO wake websocket 断开后的 `/sync` 重试行为。

## 9. Release Gates

| Profile ID | Canonical Name | Mandatory TEST IDs |
| --- | --- | --- |
| `L1` | `Local-Core` | `TEST-GOV-001`,`TEST-CS-001`,`TEST-CS-002`,`TEST-CS-003`,`TEST-ROOM-001`,`TEST-ROOM-002`,`TEST-MEDIA-001`,`TEST-DER-001`,`TEST-SEC-001`,`TEST-OPS-001`,`TEST-COST-001` |
| `L2` | `Federation-Core` | `L1` + `TEST-FED-001`,`TEST-FED-002`,`TEST-FED-003`,`TEST-MEDIA-002` |
| `L3` | `Enterprise-Hardening` | `L2` + `TEST-AS-001` when enabled, `TEST-SEC-002`,`TEST-OPS-002`,`TEST-PERF-001`,`TEST-PERF-002` |

## 10. Coverage and Traceability Matrix Rules

* 每个 `Required-Core` `MX-ID` 必须映射到至少一个 `TEST-ID`。
* 每个 `REQ-ID` 必须至少有一个“功能正确性”测试与一个“发布证据”。
* 每次行为变更都必须更新受影响的 `TEST-ID` 覆盖清单。

## 11. Evidence Register Handoff

* 测试定义在本分册。
* 具体证据工件、位置、频率与保留策略登记在 [44-verification-and-evidence-register.md](/root/Matrix/spec/framework/44-verification-and-evidence-register.md)。
* 没有对应 `EVID-ID` 的测试通过结果，不能作为发布门禁成立依据。

## 12. 完成标准

* 每个责任域都有验证入口；
* 发布门禁可执行；
* 规范覆盖可追溯；
* 测试策略与证据寄存器已闭环；
* 可直接开始设计测试工程与 CI 策略。
