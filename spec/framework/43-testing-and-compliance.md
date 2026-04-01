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
| `TEST-GOV-001` | source baseline, traceability, ID integrity lint | CI | `L1-L3` | 校验 `REQ/MX/CF/IF/DATA/FLOW/STATE/TEST/EVID/DEC/OQ` 链接完整性，生成并校验 machine-readable requirement register、traceability matrix 与 wildcard route expansion 审计快照，确保每个 `REQ-ID` 只有一个 canonical source row、`15-source-observation-register.md` 存在且日期/字段合法、无未登记引用、无 ID 区间/后缀缩写、无缺失 pinned source snapshot 的 `CF-ID` 被当作 `Draft-Normative`、无 compatibility page 或 `92-appendices` 中 `2.1-2.8` placeholder/informative sections 被误用为权威正文、无把仅靠 `Deferred` 降级而未经 `DEC` 或 contracts 收敛的 `OQ` 误标为 `closed`。 |
| `TEST-CS-001` | discovery, capabilities, registration availability, registration, login discovery/exchange, password change, account deactivation, refresh, logout, profile surfaces and profile propagation basics | CI + staging | `L1-L3` | 必须覆盖 `GET /login` flow advertisement、`GET /register/available` truth、`/capabilities` 中 `m.change_password` / `m.3pid_changes` / `m.get_login_token` / `m.profile_fields` truth、password change / deactivate 的 UIA 基线，并显式覆盖带 access token 与不带 access token 的 password-UIA 分支，以及 profile full-read、`keyName` GET/PUT/DELETE、`m.tz`/custom-field 语义与 profile change propagation。 |
| `TEST-CS-002` | filter lifecycle, `/sync` initial/incremental/limited/`full_state`/`use_state_after`, `include_leave`, lazy-load members, account data, push rules, and notification counts | CI + staging | `L1-L3` | 重点验证 token 单调性、filter determinism、leave-room visibility、member lazy-load 以及通知计数语义。 |
| `TEST-CS-003` | devices, to-device, key upload/query/claim, backup metadata | CI + staging | `L1-L3` | 必须验证 one-time key at-most-once。 |
| `TEST-CS-004` | explicit stub-only/unsupported route guard behavior | CI + staging | `L1-L3` | 必须验证 `IF-CS-007`,`IF-CS-053`,`IF-CS-054`,`IF-CS-055`,`IF-CS-056`,`IF-CS-057`,`IF-CS-058`,`IF-CS-059`,`IF-CS-060`,`IF-CS-061`,`IF-CS-062`,`IF-CS-063`,`IF-CS-064`,`IF-CS-065` 在当前 profile 下返回固定 disabled/unsupported wire behavior、无副作用、无下游 truth write，且 stub 短路优先于 access token / UIA / provider callout；并验证 `GET /login` / `GET /capabilities` 不会把已 stub 的 SSO、login-token、3PID surfaces 误宣称为可用。 |
| `TEST-ROOM-001` | room creation, membership, event send, redaction, receipts, typing | CI + staging | `L1-L3` | 房间核心行为。 |
| `TEST-ROOM-002` | enabled room version strategy compatibility | CI + staging | `L1-L3` | `L1` 至少覆盖 room version `12`；`L2-L3` 必须覆盖 `11` / `12` 差异，包括 redaction 与 state resolution。 |
| `TEST-FED-001` | federation discovery, key retrieval, request authentication, and query-surface auth/routing | staging | `L2-L3` | 必须覆盖 `/.well-known` / SRV / direct host paths，以及 `IF-FED-006` 的 `publicRooms` / hierarchy / directory / profile / generic query dispatch，并显式覆盖对等价请求时 federation `publicRooms` 的 `GET` / `POST` 变体共用同一 query / visibility truth path。 |
| `TEST-FED-002` | inbound/outbound txn idempotency, federation user-device/key exchange, and join/leave/knock flows | staging | `L2-L3` | 必须验证 per-server ordering、`/user/devices` / `/user/keys/query` 正确性，以及 `/user/keys/claim` 的 one-time key at-most-once。 |
| `TEST-FED-003` | missing event recovery, backfill, gap repair chaos | pre-release | `L2-L3` | 必须覆盖缺 `prev_events` / `auth_events`。 |
| `TEST-FED-004` | explicit unsupported federation route guard behavior | CI + staging | `L2-L3` | 必须验证 `IF-FED-009`,`IF-FED-010` 返回固定 wire behavior、无副作用、无 identity/token/membership truth write，且不会因为 auth 差异产生 401/403/404/200 漂移。 |
| `TEST-MEDIA-001` | local upload/download/thumbnail/quota | CI + staging | `L1-L3` | 必须验证 streaming、body limit handling、`/_matrix/client/v1/media/*` authenticated current surface，以及 deprecated `/_matrix/media/*/download` / `thumbnail` 的 legacy unauthenticated + freeze 行为；同时覆盖 animated thumbnail 变体不会污染 non-animated cache key。 |
| `TEST-MEDIA-002` | remote media cache, timeout, retry, cache eviction | staging | `L2-L3` | 受连接上限约束；必须验证 deprecated unauthenticated media routes 在 freeze 之后对 cache miss 不会触发新的远端抓取，而 current authenticated routes 仍可正常抓取与缓存。 |
| `TEST-DER-001` | search, user directory, public rooms derived consistency | CI + staging | `L1-L3` | 验证派生索引正确性与 rebuild 后一致性，并显式覆盖对等价请求时匿名 `GET /publicRooms` 与鉴权态 `POST /publicRooms` 的同语义 query dispatch / visibility fail-closed 行为；同时验证未带 access token 的 `POST /publicRooms` 被 deterministic 拒绝，而不是被降级为匿名查询。 |
| `TEST-AS-001` | appservice namespace, query, transaction delivery and retry | staging | `L3 when enabled` | appservice 开启时才进入门禁。 |
| `TEST-SEC-001` | token revocation, UIA challenge binding, secret handling, baseline abuse guards, federation auth failures | CI + staging | `L1-L3` | 重点验证 auth invalidation、`auth_version` 推进、route-bound UIA challenge 不可跨路由重放、secret boundaries，以及对始终开启的注册、登录、媒体、房间发送、搜索和本地公开入口的 baseline rate-limit / quota guard。 |
| `TEST-SEC-002` | advanced abuse resistance, SSRF, provider trust, and conditional external integrations | staging + pre-release | `L3` | 在 `TEST-SEC-001` baseline 之上，覆盖 URL preview 的 SSRF / fetch guard；若启用 pushers / external push gateway、email/SMS `requestToken` bootstrap 或 TURN credential issuance，也必须把对应 provider trust、鉴权、回调/credential 边界纳入同一门禁。 |
| `TEST-OPS-001` | new Worker -> old DO and old Worker -> new DO compatibility | staging + pre-release | `L1-L3` | 版本偏斜门禁。 |
| `TEST-OPS-002` | replay, rebuild, export, restore, scoped repair | pre-release + periodic drill | `L3` | 恢复门禁；必须显式注入“shard truth 已提交但 `DATA-OPS-010` registry upsert 失败”的故障，并验证同一幂等请求或内部 pending-marker 重试会补齐 registry row 而不会重复创建 shard truth。 |
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
* `ci-integration`、`staging`、`pre-release` 的 release-gate 运行，必须由各自环境目录中的 dedicated harness 直接驱动；仅导入 `tests/local/*` 或共享本地 mandatory suite 的薄入口，不构成 environment-backed validation。
* GitHub Actions 是 `ci-integration`、`staging`、`pre-release` non-local harness 的唯一触发入口；本地 `npm run test:all` 只可证明目录分层、skip-path 与本地组合回归仍然可执行，不得被描述成 non-local gate 已完成。
* non-local harness 必须通过真实部署后的 HTTP / RPC / Worker entrypoint 与其绑定资源驱动，不得把 `_test-runs` 本地产物、共享 local suite 结果、或结构合法但来源不可审计的 JSON 当作近真实拓扑验证。
* 任何导入到 release gate 的 non-local 运行结果，都必须使用 [26-wire-schema-catalog.md](/root/Matrix/spec/framework/26-wire-schema-catalog.md) 中的 `EnvironmentRunAttestation`；production monthly cost snapshot 必须使用 `ProdCostSnapshotAttestation`。裸 run report / prod snapshot JSON 不得直接作为发布证据入口。
* staging 必须至少包含：
  * Worker versions/deployments
  * 真正的 DO namespace
  * D1
  * R2
  * Queues

## 6. Protocol Compliance Testing

* 所有协议合规测试必须直接从 Matrix `v1.17` versioned spec 生成。
* 对使用 wildcard route family 的 contract，测试生成与治理工件都必须按 [23-interface-contract-catalog.md](/root/Matrix/spec/framework/23-interface-contract-catalog.md) 的 route pattern grammar 先展开为显式 path 列表，再做断言与审计。
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
| `L1` | `Local-Core` | `TEST-GOV-001`,`TEST-CS-001`,`TEST-CS-002`,`TEST-CS-003`,`TEST-CS-004`,`TEST-ROOM-001`,`TEST-ROOM-002`,`TEST-MEDIA-001`,`TEST-DER-001`,`TEST-SEC-001`,`TEST-OPS-001`,`TEST-COST-001` |
| `L2` | `Federation-Core` | `L1` + `TEST-FED-001`,`TEST-FED-002`,`TEST-FED-003`,`TEST-FED-004`,`TEST-MEDIA-002` |
| `L3` | `Enterprise-Hardening` | `L2` + `TEST-AS-001` when enabled, `TEST-SEC-002`,`TEST-OPS-002`,`TEST-PERF-001`,`TEST-PERF-002` |

## 10. Coverage and Traceability Matrix Rules

* 每个 `Required-Core` `MX-ID` 必须映射到至少一个 `TEST-ID`。
* 每个 `REQ-ID` 必须至少有一个“功能正确性”测试与一个“发布证据”。
* 每次行为变更都必须更新受影响的 `TEST-ID` 覆盖清单。

## 11. Evidence Register Handoff

* 测试定义在本分册。
* 具体证据工件、位置、频率与保留策略登记在 [44-verification-and-evidence-register.md](/root/Matrix/spec/framework/44-verification-and-evidence-register.md)。
* 对任何依赖 non-local harness 或 production snapshot 的 `EVID-ID`，handoff 给 `44` 的不是自由 JSON report，而是 attestation bundle + immutable provenance reference。
* 没有对应 `EVID-ID` 的测试通过结果，不能作为发布门禁成立依据。

## 12. 完成标准

* 每个责任域都有验证入口；
* 发布门禁可执行；
* 规范覆盖可追溯；
* 测试策略与证据寄存器已闭环；
* 可直接开始设计测试工程与 CI 策略。
