# Deployment, Migration, and Recovery Spec

状态：Draft-Normative
角色：交付与恢复分册
负责主文档章节：6
继承的单体章节：23-24，9.9

## 1. 文档职责

* 定义版本模型、兼容策略、部署模型、回滚边界。
* 定义 Durable Objects、D1、R2、KV 相关迁移与模式演进规则。
* 定义故障模式、重放、重建、修复、灾备与控制面流程。

明确不包含：

* 不定义协议域核心语义；
* 不定义性能成本正文；
* 不定义测试细节正文。

## 2. 版本模型

| REQ-ID | Requirement | Normative Statement |
| --- | --- | --- |
| `REQ-OPS-010` | Versioned deployments | 生产发布必须使用 Worker versions/deployments 模型。 |
| `REQ-OPS-011` | Compatibility before rollout | 任何破坏性行为切换前必须先发布兼容代码。 |
| `REQ-OPS-012` | Migrations isolated | DO migration 必须与普通代码发布解耦。 |
| `REQ-OPS-013` | Recovery path before cleanup | 删除旧 schema、旧索引、旧对象前必须确认已有恢复入口。 |

### 2.1 Worker Versioning

* 普通代码发布允许使用 all-at-once 或 gradual deployment。
* 生产建议流程：`staging -> canary -> production`。
* 每个发布都必须记录：
  * Worker version IDs
  * active deployment composition
  * compatibility date
  * enabled flags / feature gates

## 3. Backward Compatibility Rules

### 3.1 Worker <-> DO

* 所有 `IF-INT-*` 都必须前向兼容与后向兼容。引用：`CF-DO-005`。
* 禁止在 RPC 中删除旧字段并立即假设所有对象已升级。
* 允许新增字段，但旧调用方必须可被默认值吸收。

### 3.2 Queue / Alarm / R2 Manifest

* 所有 Queue 负载必须版本化并向后兼容。
* Alarm handler 必须能处理旧状态和新状态。
* R2 manifest 与 export format 必须显式带 schema version、内容哈希、签名 key version 与 completeness state。

## 4. Durable Object Schema Evolution

### 4.1 何时需要 DO migration

以下情况才使用 Cloudflare DO migration：

* 新增 DO class
* 重命名 DO class
* 删除 DO class
* 改变 class binding / placement identity

DO migration 是原子操作，不能渐进发布。引用：`CF-DO-006`。

### 4.2 DO 内部 schema 升级

DO 内部 SQLite schema 演进规则：

1. 维护显式 `schema_version`。
2. constructor 只做轻量读和必要的同步升级。
3. 大量 backfill 或数据重写不得在 constructor 中完成。
4. 若升级需要长作业，必须发布兼容代码后再由控制面启动后台修复。

### 4.3 发布顺序

1. 发布“兼容旧 schema + 兼容新 schema”的代码。
2. 若需要，独立执行 DO migration。
3. 启动 backfill / rebuild。
4. 切换读路径。
5. 清理旧字段。

## 5. D1 Schema Evolution

* D1 只承载派生面，因此允许采用 `additive -> dual write -> backfill -> read switch -> cleanup`。
* 若启用 read replication，切换窗口内必须明确哪些读强制走 Sessions API。引用：`CF-D1-003`,`CF-D1-004`。
* D1 rebuild 必须可完全由真相面和 R2 导出重建。

## 6. R2 / KV / Queue Evolution Rules

### 6.1 R2

* 对象 key 结构变更必须使用新前缀或显式 manifest version。
* 删除旧对象前必须确认无活动读路径引用。

### 6.2 KV

* KV schema 变更通过双读、前缀切换和 TTL 失效完成。
* 不允许把 KV 数据迁移视为权威数据迁移。

### 6.3 Queue

* queue message payload 必须自带 `schema_version`。
* consumer 升级前必须确认能消费至少一个旧版本 payload。

## 7. Rolling Upgrade and Version Affinity

### 7.1 渐进发布规则

* 若使用 gradual deployment，必须打开版本监测与异常回滚门禁。
* 对同一 Durable Object，在任一部署下只会运行一个版本；但不同对象可在 rollout 期间处于不同版本。引用：`CF-DO-005`。

### 7.2 版本亲和建议

若使用 version affinity：

* client 请求建议按 `user_id` 或 `session hash` 稳定选路；
* federation 请求建议按 `server_name` 稳定选路；
* 目标是减少同一用户或同一远端服务器在 rollout 期间的版本抖动。

## 8. Secret Rotation and Deploy Coupling

* secret 变更本质上是新的 Worker version。引用：`CF-WKR-014`。
* 非渐进发布可用 `wrangler secret put/delete`。
* 渐进发布必须使用 `wrangler versions secret put/delete` 再配合 `versions deploy`。引用：`CF-WKR-014`。
* homeserver signing key、token root key、AS token、OTel credential 的轮换都必须进入发布记录。

## 9. Failure Modes

| Failure Mode | Detection | First Response | Recovery Path |
| --- | --- | --- | --- |
| Worker exceeded CPU / memory | Worker metrics + error logs | 限流、降级、回滚 | code fix + replay if needed |
| runtime update interrupted `/sync` | client retry + log pattern | 正常早返回 | no repair required |
| DO overload / restart / eviction | DO metrics + error logs | 减少热点、限流 | object remains source of truth |
| D1 overload or lag | D1 metrics | degrade search/directory | rebuild or shard expansion |
| Queue backlog storm | backlog metrics | reduce producers / scale consumers | checkpointed replay |
| R2 or remote fetch timeout | media/fed error metrics | retry with backoff | refetch / repair |
| deployment skew bug | canary metrics | halt rollout / rollback | compatible patch |

## 10. Replay and Rebuild Procedures

系统必须支持：

* 从 `RoomDO` + `DATA-R2-004` 重建搜索和目录。
* 从 `UserDO` 导出重建用户目录、设备投影与 backup metadata。
* 从 `RemoteServerDO` 队列与真相面重建联邦投递状态。

所有重建都必须：

* 使用 `DATA-OPS-001` manifest
* 记录 `DATA-OPS-002` checkpoint
* 经 `IF-INT-WKR-002` 或 `IF-QUE-004` 执行

## 11. Disaster Recovery and Data Repair

### 11.1 DR 基线

* D1 在 Workers Paid 上有 `30` 天 Time Travel / point-in-time recovery。引用：`CF-D1-005`。该值属于平台事实断言，发布与年度治理审查时必须重新核对。
* DO 权威状态没有等价内建 PITR，必须由应用层导出补足。引用：`CF-DO-004`。
* 生产默认 DR 目标为 `RPO <= 15 min`、`RTO <= 8 h`，适用于单 homeserver 部署在支持规模内的全量 namespace 恢复。

### 11.2 应用层导出要求

* `ops-worker` 必须先创建全局 `export_epoch`，再触发 `RoomDO`、`UserDO` 与控制面导出；同一轮全量导出的所有 manifest 都必须引用同一个 `export_epoch`。
* `ops-worker` 在创建 `export_epoch` 时，必须同步冻结本轮导出的 shard registry snapshot；该 snapshot 至少枚举 room shards、user shards、remote-server shards 与 control-plane shards。导出开始后新创建的 shard 自动归入下一轮 `export_epoch`。
* `RoomDO` 必须至少每 `15` 分钟导出房间 archive segment 与 state snapshot manifest 到 R2。
* `UserDO` 必须至少每 `15` 分钟导出设备、账号数据、密钥和 backup manifest 快照到 R2。
* 每个 shard manifest 都必须记录 `started_at`、`completed_at`、source watermark / serial、对象哈希列表、schema version、签名 key version 与 completeness state。
* 每个 shard manifest 还必须记录 `registry_snapshot_id` 与该 shard 在 registry 中的唯一 shard key；不得在导出后期再动态追加“临时发现的 shard”到同一轮 registry。
* 只有当一组导出在同一 `export_epoch` 下、所有必需 shard manifest 都标记为 `complete`，并且签名 / 哈希校验通过时，才允许用于全量 namespace restore。
* `partial` 或 `incomplete` 导出只能用于 scoped repair；若要把它用于其他用途，必须先产生 `DEC-ID`。
* `ops-worker` 必须支持从完整导出包重放到新的 namespaces。

`complete` 的判定必须基于 registry snapshot，而不是“当前看起来导出了很多 shard”。至少满足：

* registry 中每个 required shard 恰好对应一个终态 `complete` manifest
* 不允许存在缺失 shard、重复 complete manifest 或 `watermark` 回退
* bundle manifest 必须包含 registry snapshot 的 hash，以便 restore 前验证“所验的完整性集合”和“当时声明的完整性集合”一致

#### 11.2.1 Export Manifest 的 Canonicalization、Hash、Signature、Encryption

导出与恢复格式必须固定以下密码学规则：

* shard manifest、bundle manifest 与 control-plane metadata 一律使用 RFC 8785 JCS canonical JSON，编码为 UTF-8。
* 每个导出对象的 `content_hash` 必须是 `base64url(sha256(raw_bytes))`。
* 每个 unsigned manifest 都必须至少包含：
  * `manifest_version`
  * `export_epoch`
  * `job_id`
  * `shard_id` 或 `bundle_id`
  * `hash_algorithm`
  * `signature_algorithm`
  * `encryption_algorithm`
  * `signing_key_version`
  * `encryption_key_version`
  * `objects[]`
  * `completeness_state`
* manifest hash 必须对 unsigned manifest 的 canonical bytes 计算；签名对象不得把自身签名字段再次纳入 hash。
* manifest 签名算法固定为 `Ed25519`；验证方必须按 `signing_key_version` 选择对应验证公钥。
* 导出对象加密固定为 `AES-256-GCM`；每个 bundle 或 shard 必须有独立 nonce / data key，并通过 `encryption_key_version` 绑定到外层 KEK 或外部 KMS。
* 任何 restore 在开始导入前都必须依次完成 completeness、hash、signature、key-version allowlist 与 decryptability 校验；任一步失败都必须 fail-closed。

#### 11.2.2 Restore Cutover 语义

* full namespace restore 只能导入到新的 Worker / DO / D1 / R2 / KV namespaces，不得原地覆写正在服务的生产权威状态。
* 执行 restore cutover 前，`ops-worker` 必须先把公网写流量切到 quiescing 状态；此时只允许健康检查、作业查询与显式允许的只读请求继续通过。
* quiescing 窗口内必须记录最终 source watermark，并把它写入 restore job manifest。
* restore 导入完成后，必须先执行结构校验、抽样读校验与关键协议路径 smoke test，再允许切换公网流量。
* 切流后旧 namespace 必须保留为只读回退源，直到通过发布门禁或人工确认删除。

### 11.3 修复流程

必须支持以下 scoped repair：

* single room graph repair
* single user device/keys repair
* single remote server txn queue repair
* remote media catalog repair
* search reindex

## 12. Operations Control Plane

* 控制面只能通过 `ops-worker` 进入。
* 控制面入口必须使用专用管理域；人类入口使用 Cloudflare Access JWT，自动化入口使用 Access service token 通过 Access 策略，但到达 `ops-worker` 时仍必须表现为可验证的 Access JWT。
* 所有控制面写请求都必须通过 HTTP `Idempotency-Key` 头携带 `idempotency_key`，并显式声明目标 scope。
* 所有重建、回放、迁移、修复都必须是显式作业对象。
* 所有控制面写请求与作业状态变更都必须追加 `DATA-OPS-004` 审计记录。
* 每个作业必须持有：
  * `job_id`
  * `operator_principal_id`
  * auth mechanism
  * scope snapshot
  * `idempotency_key`
  * target scope
  * schema/version context
  * checkpoint state

## 13. 交付域测试入口

| Area | TEST IDs | EVID IDs |
| --- | --- | --- |
| deploy skew and compatibility | `TEST-OPS-001` | `EVID-OPS-001` |
| rebuild and disaster recovery | `TEST-OPS-002` | `EVID-OPS-002` |
| cost/perf regressions during rollout | `TEST-PERF-001`,`TEST-COST-001` | `EVID-PERF-001`,`EVID-COST-001` |

## 14. 完成标准

* 平滑发布和版本偏斜问题有明确定义；
* 数据迁移边界可直接实施；
* 故障与恢复路径闭合；
* 交付域已接入平台台账、契约目录、流程目录与验证目录；
* 运维控制面职责明确。
