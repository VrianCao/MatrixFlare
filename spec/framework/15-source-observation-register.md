# Source Observation Register

状态：Draft-Normative
角色：上游来源巡检寄存器
负责主文档章节：1
扩展范围：Matrix 与 Cloudflare 上游事实漂移审计

## 1. 文档职责

* 作为上游来源观察记录的唯一权威文件。
* 固定 Matrix 与 Cloudflare 观察日期、已钉死基线、最新观察结果、delta 结论与后续动作。
* 为版本升级、上游漂移审查、`TEST-GOV-001` 与 `EVID-GOV-001` 提供机器可审计输入。

明确不包含：

* 不直接替代 `11` 的权威与版本治理规则；
* 不直接替代 `13` 的 Cloudflare 约束台账；
* 不直接替代 `research/sources/` 快照本体。

## 2. 寄存器规则

* 本文件是 `11-spec-authority-and-version-policy.md` 中 “来源巡检寄存器” 的唯一权威落位。
* 每一行都必须对应一个可审计的 source family 或紧密耦合的页面集合，不得把互不相关的产品线混成单行。
* `Pinned Baseline` 必须引用已进入现行规范体系的版本或本地快照集合。
* `Observed Latest` 必须反映最近一次人工或自动巡检时看到的上游最新值。
* `Delta Summary` 只允许 `none`、`additive`、`breaking`、`unclear` 四类。
* 若 `Delta Summary != none`，则 `Action Required` 不得为 `no-op`。
* `TEST-GOV-001` 必须校验本文件存在、字段完整、日期合法且与相关治理分册引用一致。

## 3. Observation Register

| Source Family | Pinned Baseline | Observed Latest | Observation Date | Delta Summary | Action Required | Owner | Review Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Matrix client/server/federation/application-service/rooms | local snapshots `research/sources/matrix-v1.17-client-server-api.html`,`research/sources/matrix-v1.17-server-server-api.html`,`research/sources/matrix-v1.17-application-service-api.html`,`research/sources/matrix-v1.17-rooms.html`,`research/sources/matrix-v1.17-room-v11.html`,`research/sources/matrix-v1.17-room-v12.html` | Matrix `latest` observed as `v1.17` | `2026-03-26` | `none` | `no-op` | architecture | pre-release + monthly |
| Cloudflare Workers runtime and pricing surfaces | local snapshots `research/sources/cloudflare-workers-limits.md`,`research/sources/cloudflare-workers-pricing.md`,`research/sources/cloudflare-workers-logs.md`,`research/sources/cloudflare-workers-opentelemetry.md`,`research/sources/cloudflare-workers-traces.html`,`research/sources/cloudflare-workers-rpc.md`,`research/sources/cloudflare-service-bindings.md`,`research/sources/cloudflare-workers-placement.md`,`research/sources/cloudflare-workers-gradual-deployments.md`,`research/sources/cloudflare-workers-versions-deployments.md`,`research/sources/cloudflare-workers-secrets.md` | limits/deployment semantics still support current `CF-WKR-*` rows, but observability pricing pages conflict on tracing quota/pricing/retention semantics | `2026-03-26` | `unclear` | `track OQ-0002`, keep tracing cost assertions parameterized, and re-check before release gates that rely on observability pricing | platform | pre-release + monthly |
| Cloudflare storage and queue surfaces | local snapshots `research/sources/cloudflare-do-limits.md`,`research/sources/cloudflare-do-lifecycle.md`,`research/sources/cloudflare-do-alarms.md`,`research/sources/cloudflare-do-known-issues.md`,`research/sources/cloudflare-do-rpc-stubs.md`,`research/sources/cloudflare-do-migrations.md`,`research/sources/cloudflare-do-sqlite-storage-api.md`,`research/sources/cloudflare-do-websockets.md`,`research/sources/cloudflare-do-pricing.md`,`research/sources/cloudflare-d1-limits.md`,`research/sources/cloudflare-d1-read-replication.md`,`research/sources/cloudflare-d1-pricing.md`,`research/sources/cloudflare-kv-how-it-works.md`,`research/sources/cloudflare-r2-consistency.md`,`research/sources/cloudflare-r2-limits.md`,`research/sources/cloudflare-r2-pricing.md`,`research/sources/cloudflare-queues-pricing.md` | latest observed docs match pinned semantics used by current `CF-DO-*`,`CF-D1-*`,`CF-KV-*`,`CF-R2-*`,`CF-QUE-*` rows | `2026-03-26` | `none` | `no-op` | platform | pre-release + monthly |
| Cloudflare network and access control surfaces | local snapshots `research/sources/cloudflare-network-ports.md`,`research/sources/cloudflare-access-application-paths.md`,`research/sources/cloudflare-access-validate-jwt.md`,`research/sources/cloudflare-access-service-tokens.md` | latest observed docs match pinned semantics used by current `CF-NET-*` rows | `2026-03-26` | `none` | `no-op` | security + platform | pre-release + monthly |

## 4. Drift Handling Rules

* 若某行出现 `additive` 或 `unclear` delta，相关 owner 必须在同一轮审查中决定是更新现行规范、登记 `OQ-ID`，还是创建 `DEC-ID` 维持现状。
* 若某行出现 `breaking` delta，则在受影响 `REQ/MX/CF/IF/DATA/TEST/EVID` 更新前，不得继续宣称对应能力的发布基线未变。
* `Action Required` 不是 `no-op` 的行，必须在下次 release gate 前关闭为 `DEC-ID`、文档更新，或明确的延期决策。

## 5. 完成标准

* 来源观察记录有唯一权威文件；
* Matrix 与 Cloudflare 观察口径已统一；
* 上游漂移能够进入变更控制与发布门禁；
* 开发与审计团队都能据此判断“当前基线是否仍成立”。
