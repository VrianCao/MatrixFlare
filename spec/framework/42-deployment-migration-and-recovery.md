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
* 若该次发布包含 Durable Object migration，则不得使用 `wrangler versions upload` 作为版本上传步骤；必须改用 `wrangler deploy`。引用：`CF-WKR-012`,`CF-DO-006`。
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

* D1 在本系统中同时承载两类数据：可重建派生面，以及少量权威控制面元数据。
* 对可重建派生表，允许采用 `additive -> dual write -> backfill -> read switch -> cleanup`。
* 对权威控制面表，包括 `DATA-D1-005`,`DATA-D1-006` 与所有 D1-backed `DATA-OPS-*`，不得假设“drop and rebuild 即可恢复”；必须先完成兼容发布、导出验证与回滚路径验证，再允许 destructive cleanup。
* 若启用 read replication，切换窗口内必须明确哪些读强制走 Sessions API。引用：`CF-D1-003`,`CF-D1-004`。
* 任一 D1 backfill、rebuild 或控制面查询都必须显式遵守“单 invocation 最多 `1,000` 条 D1 queries”“单 SQL 最长 `30s`”“最多 `6` 个 D1 connections”的平台边界。引用：`CF-D1-007`,`CF-D1-008`,`CF-D1-009`。
* 对可重建派生表的 D1 rebuild，必须可完全由数据面真相和 R2 导出重建。

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
* 任何用于签发 stateless signed token 的 key rotation 都必须兼容 active deployment composition 中可能并存的两个 Worker versions；旧 verify key 只能在 rollout 完成且对应 token 最大 TTL 过去后移除。引用：`CF-WKR-012`,`CF-WKR-014`。
* 对 `DATA-ID-006` 这类仅由 `gateway-worker` 使用的签名 token，默认部署策略应保持“单 Worker 负责签发与验证”；若未来扩展为跨 Worker 验证，必须先把共享 secret 方案写入发布 runbook，并按 `CF-WKR-021` 落地。

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

### 11.2 应用层导出模式

系统必须区分两类导出，而不是把所有恢复能力都压成“每 `15` 分钟全量导一次 namespace”：

* continuous recovery checkpoint export：自动、分 shard、增量，仅要求 dirty shard 在 RPO 窗口内把最新权威 watermark 刷到恢复介质；
* operator full export bundle：显式控制面作业，冻结 registry snapshot，并产出可审计、可完整验证的 bundle 以供 namespace restore。

#### 11.2.0 Shard Registry 基线

* 全量导出、恢复 completeness 与巡检必须以 `DATA-OPS-010` shard registry 为基线，而不是依赖运行时“扫描到哪些 shard”。
* 任一路径只要会首次创建可导出的 `UserDO`、`RoomDO`、`RemoteServerDO` 或 control-plane shard，就必须先提交本地权威 truth，再在同一外部请求周期或后续由 durable 幂等映射/本地 pending-marker 驱动的重试路径中完成 `DATA-OPS-010` upsert；只有当该 post-commit success barrier durable 完成后，才允许返回 `terminal success`。
* 若 shard identity 需要在首次写入时分配，则必须先 durable 持久化“外部幂等域 -> shard identity”映射，再允许返回 `retryable non-success` 或 `terminal success`；后续同一幂等请求只能复用该 identity。
* 若 shard truth 已提交但 `DATA-OPS-010` upsert 失败，请求必须返回 `retryable non-success`；除同一幂等请求重试外，shard 自身还必须持久化 `registry_upsert_pending` 或等价标记，并通过内部 alarm/queue/repair loop 继续补齐缺失 registry row，而不得把 registry completeness 依赖于客户端重试。
* full export 在开始切分 shard 工作前，必须先把 `DATA-OPS-010` 冻结为 `DATA-OPS-011` registry snapshot，并在后续所有 manifest 中引用该 snapshot 的 hash。

#### 11.2.1 Continuous Recovery Checkpoint Export

* 只有 source watermark 自上次 complete checkpoint 之后发生推进的 dirty shard，才要求进入恢复导出；idle shard 不得被强制每 `15` 分钟重导一次。
* dirty `RoomDO` shard 必须在“首次未导出 watermark 推进”后的 `15` 分钟内，把新增 archive segments 与对应 checkpoint manifest 刷到 R2。
* dirty `UserDO` shard 必须在相同 `15` 分钟窗口内，把设备、账号数据、密钥与 backup metadata 的恢复快照或增量分片刷到 R2。
* `RemoteServerDO` 与控制面 shard 若其权威状态参与 DR，也必须遵守同一 dirty-shard checkpoint cadence。
* 每个 checkpoint manifest 都必须记录 `checkpoint_id`、`started_at`、`completed_at`、source watermark / serial、对象哈希列表、schema version、签名 key version 与 completeness state。
* continuous checkpoint 不要求创建全局 `export_epoch`；它的职责是满足 RPO，而不是直接充当“单次全量 bundle”。checkpoint artifacts 必须使用 `checkpoint_id` 作为主标识，只有被 full export bundle 采纳时才额外挂接 `export_epoch`。

#### 11.2.1.1 Shard Watermark 定义

continuous checkpoint 与 full export 复用 checkpoint 时，`source watermark` 的最小语义固定如下：

* `RoomDO`：`max_committed_room_pos`,`current_snapshot_id`,`forward_extremities_hash`
* `UserDO`：`max_user_stream_pos`,`device_state_version`,`to_device_queue_highwater`
* `RemoteServerDO`：`max_outbound_txn_seq`,`retry_schedule_version`,`inbound_txn_cache_version`
* control-plane shard：`max_audit_event_seq` 或该 shard 的等价单调序号

实现规则：

* watermark 必须单调前进；任一 checkpoint 若出现回退，必须标记为 `incomplete` 并禁止用于 full export completeness。
* full export 复用旧 checkpoint 时，必须验证其 watermark 不晚于本轮 cut 且未回退。
* restore preflight 必须按 shard 类型解释 watermark，而不是把所有 shard 当作同一种整数序号。

#### 11.2.1.2 Checkpoint Manifest Object Schema

每个 checkpoint manifest 的 `objects[]` 项至少必须包含以下字段：

* `object_id`
* `object_kind`
* `shard_type`
* `shard_key`
* `data_ids`
* `required_for_restore`
* `apply_phase`
* `range_start`
* `range_end`
* `content_hash`
* `codec`
* `encryption_key_version`
* `byte_size`
* `record_count`

约束：

* `data_ids` 必须是 canonical `DATA-*` 显式枚举，不得写自然语言。
* `apply_phase` 首版只允许 `truth-core`、`truth-aux`、`ephemeral-current`、`dedupe-and-outbox`、`control-plane` 五类。
* `required_for_restore = false` 的对象可以加速恢复，但不得成为恢复正确性的唯一来源。

#### 11.2.1.2.1 Object Codec and Range Semantics

为避免“manifest 写了 `codec`/`range_*` 但实现自行脑补”，首版恢复对象格式再固定以下规则：

* `objects[].codec` 只允许以下集合：
  * `jcs-json`：单个 canonical JSON 文档，适用于 manifest-like、current-state-like、reference-set-like 对象。
  * `jsonl-gzip`：UTF-8 LF-delimited canonical JSON records，经 `gzip` 压缩；适用于 append-only 或批量记录分段。
* 除 `codec = jcs-json` 外，`record_count` 必须大于 `0`；`codec = jcs-json` 时 `record_count` 固定为 `1`。
* `range_start` / `range_end` 必须使用与 shard/object 自然排序一致的 source order；禁止写“第几个文件”之类与恢复语义无关的局部序号。
* append-only segment 的 `range_start` / `range_end` 必须是闭区间；同一 shard 同一 object kind 的两个 complete segment 不得声明相互重叠但 hash 不同的 coverage。
* current-state-like 对象若只表达某个快照或当前值，`range_start` 与 `range_end` 必须相等，并等于该对象对应的 snapshot/version/watermark。
* `range_start` / `range_end` 的类型必须在同一 `object_kind` 内保持稳定；不得同一 kind 有时写整数、有时写 JSON object。

首版各主要对象的最小编码/范围约束如下：

| Object Kind | Allowed Codec | `range_start` / `range_end` Unit | Notes |
| --- | --- | --- | --- |
| `room-events-metadata-segment` | `jsonl-gzip` | inclusive `room_pos` | 每条记录按 committed room order 排序。 |
| `room-hot-event-json-segment` | `jsonl-gzip` | inclusive `room_pos` | 与 metadata segment 的 event 集必须可对齐。 |
| `room-prev-edges-segment` | `jsonl-gzip` | inclusive `room_pos` | 以 child event 的 committed order 定位。 |
| `room-auth-edges-segment` | `jsonl-gzip` | inclusive `room_pos` | 以 child event 的 committed order 定位。 |
| `room-state-snapshot-segment` | `jsonl-gzip` | inclusive `snapshot_id` | 必须保持 snapshot chain 可恢复。 |
| `room-membership-current` | `jcs-json` | single `snapshot_id` or membership version | 只表达 checkpoint cut 时的当前面。 |
| `room-forward-extremities-current` | `jcs-json` | single `snapshot_id` | 与当前 snapshot 对齐。 |
| `room-receipts-current` | `jcs-json` | single receipt version | 非权威核心，但范围仍须可解释。 |
| `room-typing-current` | `jcs-json` | single typing version | 可恢复后按 TTL 再收敛。 |
| `room-fanout-outbox-segment` | `jsonl-gzip` | inclusive `room_pos` | 每条记录必须能回链 `DATA-ROOM-011` 主键。 |
| `room-client-txn-dedupe-segment` | `jsonl-gzip` | inclusive dedupe serial | 必须保持 public txn 重试裁决。 |
| `room-archive-reference-set` | `jcs-json` | single checkpoint-local coverage descriptor | 只允许引用已存在且 hash 可验的 cold archive 对象。 |
| `user-identity-and-session-segment` | `jsonl-gzip` | inclusive per-user entity serial | 顺序至少保证 session/device/key 依赖可恢复。 |
| `user-profile-and-account-segment` | `jsonl-gzip` | inclusive profile/account serial | profile、presence、push-rules、filter 共享统一 cut。 |
| `user-stream-and-todevice-segment` | `jsonl-gzip` | inclusive `user_stream_pos` | `/sync` 与 to-device 恢复以此为准。 |
| `remote-outbound-queue-segment` | `jsonl-gzip` | inclusive `outbound_txn_seq` | 必须保持同远端排序。 |
| `remote-inbound-txn-segment` | `jsonl-gzip` | inclusive inbound dedupe serial | 必须保持幂等结果缓存可恢复。 |
| `remote-repair-and-cache-segment` | `jsonl-gzip` | inclusive repair/cache serial | discovery cache 可选，但格式必须稳定。 |
| `ops-core-segment` | `jsonl-gzip` | inclusive control-plane audit/job serial | 控制面恢复必须可按 audit 顺序重放。 |

#### 11.2.1.3 Required Checkpoint Object Sets

| Shard Type | Required Object Kind | Covers DATA IDs | Required For Restore | Apply Phase | Notes |
| --- | --- | --- | --- | --- | --- |
| `RoomDO` | `room-events-metadata-segment` | `DATA-ROOM-001` | yes | `truth-core` | 必须覆盖自上次 complete checkpoint 之后新增或变更的 event metadata。 |
| `RoomDO` | `room-hot-event-json-segment` | `DATA-ROOM-002` | yes | `truth-core` | 仅导出尚未由 `DATA-R2-004` 冷段权威覆盖的 canonical event JSON。 |
| `RoomDO` | `room-prev-edges-segment` | `DATA-ROOM-003` | yes | `truth-core` | 恢复 DAG 必需。 |
| `RoomDO` | `room-auth-edges-segment` | `DATA-ROOM-004` | yes | `truth-core` | 恢复 auth chain 必需。 |
| `RoomDO` | `room-state-snapshot-segment` | `DATA-ROOM-005`,`DATA-ROOM-006` | yes | `truth-core` | 必须能恢复 current snapshot 与历史 snapshot 链。 |
| `RoomDO` | `room-membership-current` | `DATA-ROOM-007` | yes | `truth-aux` | 恢复当前 membership 裁决面。 |
| `RoomDO` | `room-forward-extremities-current` | `DATA-ROOM-008` | yes | `truth-aux` | 恢复后续 state resolution 输入。 |
| `RoomDO` | `room-receipts-current` | `DATA-ROOM-009` | no | `ephemeral-current` | 可用房间 truth 重建 unread 相关派生，但为缩短恢复时间默认导出。 |
| `RoomDO` | `room-typing-current` | `DATA-ROOM-010` | no | `ephemeral-current` | 恢复后允许按 TTL 重新收敛。 |
| `RoomDO` | `room-fanout-outbox-segment` | `DATA-ROOM-011` | yes | `dedupe-and-outbox` | 保证 `/sync` 可见性不因恢复丢失 fanout。 |
| `RoomDO` | `room-client-txn-dedupe-segment` | `DATA-ROOM-012` | yes | `dedupe-and-outbox` | 保证客户端重试幂等。 |
| `RoomDO` | `room-archive-reference-set` | `DATA-R2-004` | yes | `truth-aux` | 必须列出本次 checkpoint 引用或新增的 cold segments；引用对象必须已存在并 hash 校验通过。 |
| `UserDO` | `user-identity-and-session-segment` | `DATA-USER-001`,`DATA-USER-002`,`DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-017` | yes | `truth-core` | 用户主记录、会话、设备、密钥先于用户流恢复。 |
| `UserDO` | `user-profile-and-account-segment` | `DATA-USER-006`,`DATA-USER-007`,`DATA-USER-009`,`DATA-USER-012`,`DATA-USER-013`,`DATA-USER-014`,`DATA-USER-015` | yes | `truth-aux` | 恢复 profile、presence、push-rules 与 filter。 |
| `UserDO` | `user-stream-and-todevice-segment` | `DATA-USER-008`,`DATA-USER-010`,`DATA-USER-011`,`DATA-USER-016` | yes | `dedupe-and-outbox` | 保证 `/sync` token、to-device 和 key backup manifest 语义。 |
| `RemoteServerDO` | `remote-outbound-queue-segment` | `DATA-FED-001`,`DATA-FED-002` | yes | `truth-core` | 恢复出站排序与退避。 |
| `RemoteServerDO` | `remote-inbound-txn-segment` | `DATA-FED-003`,`DATA-FED-006` | yes | `dedupe-and-outbox` | 保证入站事务幂等与稳定响应。 |
| `RemoteServerDO` | `remote-repair-and-cache-segment` | `DATA-FED-004`,`DATA-FED-005` | no | `truth-aux` | discovery cache 可重新拉取，但 gap repair backlog 默认导出。 |
| `control-plane` | `ops-core-segment` | `DATA-D1-005`,`DATA-D1-006`,`DATA-OPS-001`,`DATA-OPS-002`,`DATA-OPS-003`,`DATA-OPS-004`,`DATA-OPS-010`,`DATA-OPS-011` | yes | `control-plane` | control-plane shard 的最小恢复集。 |

#### 11.2.1.4 Restore Apply Order

restore 必须按 `apply_phase` 执行，且至少满足以下顺序：

1. `truth-core`
2. `truth-aux`
3. `ephemeral-current`
4. `dedupe-and-outbox`
5. `control-plane`

额外规则：

* `RoomDO` 不得在 `room-events-metadata-segment` / graph / snapshot 恢复前导入 `room-fanout-outbox-segment`。
* `UserDO` 不得在 identity/session/keys 恢复前导入 `user-stream-and-todevice-segment`。
* `RemoteServerDO` 不得在 outbound queue 恢复前恢复 retry schedule。
* 任一 required object_kind 缺失时，该 shard checkpoint 必须标记为 `incomplete`，不得进入 full export completeness。

#### 11.2.1.4.1 Restore Idempotency and Conflict Rules

restore 作业必须允许因 Worker 重试、Queue 重试或分片恢复而重复应用同一对象，但不得把“重复应用”偷换成“静默覆盖冲突”。固定规则如下：

* 同一 `object_id` 再次导入时，若 `content_hash`、`codec`、`range_start`、`range_end` 与首次导入完全一致，则视为 idempotent replay，允许短路为 success。
* 同一 `object_id` 若出现不同 `content_hash`、不同 `codec` 或不同 range，必须立即 fail-closed；不得取“最后一个写入者”。
* append-only segment 导入时，若目标命名空间已存在同主键记录：
  * canonical payload 完全一致则允许跳过；
  * canonical payload 不一致则必须标记 restore 冲突并终止当前 shard。
* current-state-like 对象导入时，若目标当前值已存在：
  * provenance 相同且 canonical payload 一致则允许跳过；
  * provenance 不同或 payload 不同则必须视为 preflight/ordering 错误，不得覆盖。
* `dedupe-and-outbox` phase 的对象不得在其引用的 `truth-core` / `truth-aux` truth 尚未恢复时导入；若引用 truth 缺失，必须失败而不是先落“悬空 outbox / dedupe”。
* `control-plane` phase 对象若引用不存在的 `registry_snapshot_id`、`checkpoint_id` 或 `job_id`，必须失败并记录审计事件。
* restore 成功后重新执行同一 shard job，得到的结果必须是 no-op 或显式 identical replay；不得因为重复运行生成新的权威主键或推进 source watermark。

#### 11.2.2 Full Export Bundle

* `ops-worker` 发起 full export 时，必须先创建全局 `export_epoch`，再冻结本轮导出的 shard registry snapshot；该 snapshot 至少枚举 room shards、user shards、remote-server shards 与 control-plane shards。
* full export 可以复用“已经存在且 source watermark 满足 cut 条件”的最新 complete shard checkpoint；若某 shard 没有满足 cut 条件的 checkpoint，则必须为该 shard 启动 fresh export。
* full export 中的每个 shard manifest 都必须记录 `registry_snapshot_id` 与该 shard 在 registry 中的唯一 shard key；不得在导出后期再动态追加“临时发现的 shard”到同一轮 registry。
* 导出开始后新创建的 shard 自动归入下一轮 `export_epoch`，不得 retroactively 注入当前 snapshot。
* 只有当一组导出在同一 `export_epoch` 下、所有 required shard manifest 都标记为 `complete`，并且签名 / 哈希校验通过时，才允许用于全量 namespace restore。
* `partial` 或 `incomplete` 导出只能用于 scoped repair；若要把它用于其他用途，必须先产生 `DEC-ID`。
* `ops-worker` 必须支持从完整导出包重放到新的 namespaces。

`complete` 的判定必须基于 frozen registry snapshot，而不是“当前看起来导出了很多 shard”。至少满足：

* registry 中每个 required shard 恰好对应一个终态 `complete` manifest
* 不允许存在缺失 shard、重复 complete manifest 或 `watermark` 回退
* bundle manifest 必须包含 registry snapshot 的 hash，以便 restore 前验证“所验的完整性集合”和“当时声明的完整性集合”一致

#### 11.2.3 Export Manifest 的 Canonicalization、Hash、Signature、Encryption

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

#### 11.2.4 Restore Cutover 语义

* full namespace restore 只能导入到新的 Worker / DO / D1 / R2 / KV namespaces，不得原地覆写正在服务的生产权威状态。
* 执行 restore cutover 前，`ops-worker` 必须先把公网写流量切到 quiescing 状态；此时只允许健康检查、作业查询与显式允许的只读请求继续通过。
* quiescing 窗口内必须记录最终 source watermark，并把它写入 restore job manifest。
* restore 导入完成后，必须先执行结构校验、抽样读校验与关键协议路径 smoke test，再允许切换公网流量。
* 切流后旧 namespace 必须保留为只读回退源，直到通过发布门禁或人工确认删除。

### 11.3 修复流程

必须支持以下 scoped repair：

* single room graph repair
* room-to-user fanout reconcile / repair
* single user device/keys repair
* single remote server txn queue repair
* remote media catalog repair
* search reindex

## 12. Operations Control Plane

* 控制面只能通过 `ops-worker` 进入。
* 控制面入口必须使用专用管理域；人类入口使用 Cloudflare Access JWT，自动化入口使用 Access service token 通过 Access 策略，但到达 `ops-worker` 时仍必须表现为可验证的 Access JWT。
* 所有控制面写请求都必须通过 HTTP `Idempotency-Key` 头携带 `idempotency_key`，并显式声明目标 scope。
* `/_ops` request/response payload、跨 Worker job spec 与相关 queue payload 的具体字段形态，以 [26-wire-schema-catalog.md](./26-wire-schema-catalog.md) 为准。
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
