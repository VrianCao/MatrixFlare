# Data Contract Catalog

状态：Draft-Normative
角色：数据契约总目录  
负责主文档章节：3，4，6  
扩展范围：所有持久化、缓存、游标、令牌与重建输入

## 1. 文档职责

* 统一登记所有数据实体、表、对象键空间、令牌、游标和派生索引契约。
* 规定每类数据的 authority、schema owner、一致性、隐私级别、保留与恢复来源。
* 防止 schema 和 token 规则散落于不同正文中失控。

明确不包含：

* 不替代责任分册解释业务语义；
* 不替代接口契约定义传输形态；
* 不替代迁移 runbook 细节。

## 2. 全局令牌与标识数据

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-ID-001` | token | `next_batch` sync token | authoritative | `UserDO` | DO SQLite + signed token | opaque | per-user serial | none | 对客户端 opaque，内部至少包含版本和 `user_stream_pos`。 |
| `DATA-ID-002` | cursor | room pagination token | authoritative | `RoomDO` | signed cursor | opaque | per-room serial | none | 不依赖可变服务端内存。 |
| `DATA-ID-003` | token | access token hash | authoritative | `UserDO` | DO SQLite | session id / token hash | per-user serial | none | 只存 hash。 |
| `DATA-ID-004` | token | refresh token hash | authoritative | `UserDO` | DO SQLite | refresh session id | per-user serial | none | 轮换后旧 token 必须可判失效。 |
| `DATA-ID-005` | manifest | queue job id / replay job id | authoritative | producer | DO SQLite / D1 control plane | job id | per job serial | control plane log | 用于补偿、取消和恢复。 |

## 3. `UserDO` 数据契约

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-USER-001` | table | sessions | authoritative | `UserDO` | DO SQLite | `session_id` | per-user serial | user export | 包含 access/refresh 生命周期字段。 |
| `DATA-USER-002` | table | devices | authoritative | `UserDO` | DO SQLite | `device_id` | per-user serial | user export | 设备显示名、最近活跃等。 |
| `DATA-USER-003` | table | device keys / cross-signing | authoritative | `UserDO` | DO SQLite | `{device_id,key_id}` | per-user serial | user export | 包含签名与版本戳。 |
| `DATA-USER-004` | table | one-time keys | authoritative | `UserDO` | DO SQLite | `{device_id,algorithm,key_id}` | per-user serial | none | claim 后进入 tombstone 或删除。 |
| `DATA-USER-005` | table | fallback keys | authoritative | `UserDO` | DO SQLite | `{device_id,algorithm,key_id}` | per-user serial | user export | 与上传和 `/sync` 计数联动。 |
| `DATA-USER-006` | table | global account data | authoritative | `UserDO` | DO SQLite | `type` | per-user serial | user export | 按最新值覆盖。 |
| `DATA-USER-007` | table | room account data | authoritative | `UserDO` | DO SQLite | `{room_id,type}` | per-user serial | user export | RoomDO 不直接拥有此数据。 |
| `DATA-USER-008` | table | to-device queue | authoritative | `UserDO` | DO SQLite | `{target_device_id,stream_pos}` | per-user serial | none | 读取后按设备确认收割。 |
| `DATA-USER-009` | table | presence state | authoritative | `UserDO` | DO SQLite | `user_id` | per-user serial | user export | 当前值 + version。 |
| `DATA-USER-010` | table | user stream | authoritative | `UserDO` | DO SQLite | `stream_pos` | per-user serial | rebuild from truth + export | `/sync` 唯一用户增量流。 |
| `DATA-USER-011` | table | room key backup manifest | authoritative | `UserDO` | DO SQLite | `backup_version` | per-user serial | user export | 只保存备份版本、计数、etag 等元数据，不解释密钥内容。 |
| `DATA-USER-012` | table | profile document | authoritative | `UserDO` | DO SQLite | `key_name` | per-user serial | user export | 独立于 account data；包含 `displayname`、`avatar_url`、`m.tz` 与允许的 namespaced custom fields；同一逻辑文档必须持有单调递增的 `profile_version`，用于传播、重放与去重。 |
| `DATA-USER-013` | table | push rules overrides / enablement | authoritative | `UserDO` | DO SQLite | `{scope,kind,rule_id}` | per-user serial | user export | 默认规则来自 Matrix `v1.17` 基线；这里只存用户覆盖、顺序和 enabled 状态。 |
| `DATA-USER-014` | table | stored filters | authoritative | `UserDO` | DO SQLite | `filter_id` | per-user serial | user export | 存 canonical filter JSON、filter hash 和创建版本。 |
| `DATA-USER-015` | table | pending media upload grants | authoritative | `UserDO` | DO SQLite | `pending_upload_id` | per-user serial | none | 记录上传配额检查结果、允许的 MIME/尺寸、TTL 与 finalize 状态；R2 写失败或超时必须可撤销。 |

## 4. `RoomDO` 数据契约

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-ROOM-001` | table | events metadata | authoritative | `RoomDO` | DO SQLite | `event_id` / `room_pos` | per-room serial | R2 archive + replay | 热层必须保留最小元数据。 |
| `DATA-ROOM-002` | table | hot canonical event JSON | authoritative | `RoomDO` | DO SQLite | `event_id` | per-room serial | R2 archive | 仅保留热点时间窗。 |
| `DATA-ROOM-003` | table | prev edges | authoritative | `RoomDO` | DO SQLite | `{event_id,prev_event_id}` | per-room serial | replay | DAG 结构。 |
| `DATA-ROOM-004` | table | auth edges | authoritative | `RoomDO` | DO SQLite | `{event_id,auth_event_id}` | per-room serial | replay | auth chain 结构。 |
| `DATA-ROOM-005` | table | state snapshots | authoritative | `RoomDO` | DO SQLite | `snapshot_id` | per-room serial | replay | extremity-set 到 resolved state 的缓存。 |
| `DATA-ROOM-006` | table | state entries | authoritative | `RoomDO` | DO SQLite | `{snapshot_id,type,state_key}` | per-room serial | replay | 当前状态与历史快照公用形态。 |
| `DATA-ROOM-007` | table | membership projection | authoritative | `RoomDO` | DO SQLite | `{user_id}` | per-room serial | replay | 房间主权 membership 当前视图。 |
| `DATA-ROOM-008` | table | forward extremities | authoritative | `RoomDO` | DO SQLite | `event_id` | per-room serial | replay | 状态解析输入。 |
| `DATA-ROOM-009` | table | receipts current view | authoritative | `RoomDO` | DO SQLite | `{receipt_type,user_id,thread_id}` | per-room serial | none | 只保留最新值。 |
| `DATA-ROOM-010` | table | typing current view | authoritative | `RoomDO` | DO SQLite | `user_id` | per-room serial | none | 由 alarm 过期。 |

## 5. `RemoteServerDO` 数据契约

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-FED-001` | table | outbound transactions | authoritative | `RemoteServerDO` | DO SQLite | `txn_id` | per-server serial | local truth replay | payload 一旦入队不可变。 |
| `DATA-FED-002` | table | retry schedule | authoritative | `RemoteServerDO` | DO SQLite | `txn_id` | per-server serial | derived from queue | attempt count、next_retry_at。 |
| `DATA-FED-003` | table | inbound txn dedupe | authoritative | `RemoteServerDO` | DO SQLite | `{origin,txn_id}` | per-server serial | none | 用于重复提交幂等。 |
| `DATA-FED-004` | table | gap repair backlog | authoritative | `RemoteServerDO` | DO SQLite | repair job id | per-server serial | repair manifest | 缺事件与缺状态恢复任务。 |
| `DATA-FED-005` | cache/table | discovery and remote key cache | cache-derived | `RemoteServerDO` | DO SQLite + KV optional | `{server_name,key_id}` | cache semantics | refetch | 不能跳过官方发现流程。 |

## 6. D1 Derived Data Contracts

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-D1-001` | table | search index rows | derived | `jobs-worker` | D1 | `event_id` | eventual | full reindex | 只索引可见文本与必要 filter 字段。 |
| `DATA-D1-002` | table | user directory | derived | `jobs-worker` | D1 | `user_id` | eventual | rebuild from `UserDO` exports | 来源于 `DATA-USER-012` 与本地目录策略；受隐私与可发现性规则约束。 |
| `DATA-D1-003` | table | public room directory | derived | `jobs-worker` | D1 | `room_id` | eventual | rebuild from `RoomDO` | 可见性随 join rules/public flag 更新；每行必须带来源 `room_serial` / visibility watermark，用于判断“可见性是否不确定”。 |
| `DATA-D1-004` | table | media catalog | derived | `jobs-worker` | D1 | `mxc_uri` | eventual | R2 listing + finalize logs | 不能成为下载前置单点。 |
| `DATA-D1-005` | table | appservice config / txn cursors | authoritative-control-plane | `ops-worker` / `jobs-worker` | D1 + secrets | `{appservice_id}` | strong at primary / session consistent | config backup | 控制面数据，不是房间或用户真相。 |
| `DATA-D1-006` | table | operator authz policy | authoritative-control-plane | `ops-worker` | D1 + Cloudflare Access config | `principal_id` | strong at primary / session consistent | config backup | 记录人类/自动化 operator principal、Access binding、允许 scope、target scope 约束、失效时间与审计要求；不存 Access secret 本体。 |

### 6.1 `DATA-D1-006` Operator Authz Policy 最小形态

`DATA-D1-006` 至少必须能表达以下字段：

* `principal_id`
* `principal_type`：`human` 或 `service`
* `access_issuer`
* `access_audience`
* `access_subject_binding`
* `allowed_scopes`
* `target_scope_constraints`
* `expires_at`
* `disabled_at`
* `require_reason`
* `require_ticket`

规范 scope vocabulary 首版固定为：

* `ops.read`
* `ops.audit.read`
* `ops.export.write`
* `ops.restore.write`
* `ops.rebuild.write`
* `ops.repair.write`
* `ops.appservice.write`
* `ops.schema.write`

裁决规则：

* `ops-worker` 必须先完成 Access JWT 验证，再把 `{issuer,aud,stable_subject}` 映射为 `principal_id`
* `access_subject_binding` 的稳定主体计算必须固定：
  * `human` principal 默认使用 Access JWT `sub`
  * `service` principal 不得依赖空 `sub`；必须使用 Access identity 中稳定的 service token 标识，例如 `common_name` / Client ID 等价字段
* scope 计算必须 fail-closed；无匹配 principal 或无匹配 scope 时必须返回 `403`
* `target_scope_constraints` 至少必须支持 `global`、`room_id`、`user_id`、`server_name`、`appservice_id` 五类约束
* 不允许使用隐式通配符；任何 wildcard 或前缀匹配都必须在本表中显式表示

## 7. R2 / KV Contracts

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-R2-001` | object | local media object | authoritative | media subsystem | R2 | `media/local/{media_id}` | strong | none | 本地媒体对象真相。 |
| `DATA-R2-002` | object | remote media cache object | authoritative-cache | media subsystem | R2 | `media/remote/{origin}/{media_id}` | strong | refetch remote | 可按策略驱逐重取。 |
| `DATA-R2-003` | object | thumbnail object | derived | `jobs-worker` | R2 | `media/thumb/...` | strong | regenerate | 变体由 `{width,height,method}` 唯一决定。 |
| `DATA-R2-004` | object | room cold archive segments | authoritative-cold | `RoomDO` + `jobs-worker` | R2 | `archive/rooms/{room_id}/...` | strong | replay source | RoomDO 热层保留索引；每个 segment 都必须被 manifest 引用并带内容哈希、sequence、`export_epoch` 与签名 key version。 |
| `DATA-R2-005` | object | export / recovery bundles | authoritative-ops | `ops-worker` | R2 | `exports/...` | strong | none | 仅控制面产生；bundle manifest 必须包含 schema version、内容哈希、签名、加密 key version 与 completeness 标记。 |
| `DATA-R2-006` | object | encrypted room key backup segments | authoritative-opaque | `UserDO` | R2 | `backup/{user_id}/{backup_version}/...` | strong | user export | 服务端视为加密 opaque blob。 |
| `DATA-KV-001` | keyspace | `/.well-known` cache | cache | `gateway-worker` | KV | `wellknown:*` | eventual | refetch | 可整前缀清空。 |
| `DATA-KV-002` | keyspace | remote discovery / capability cache | cache | `gateway-worker` / `RemoteServerDO` | KV | `remote:*` | eventual | refetch | 只能作性能缓存。 |

## 8. Recovery and Rebuild Contracts

| DATA-ID | Category | Logical Entity / Shape | Authority | Runtime Owner | Physical Store | Key / Pattern | Consistency | Recovery Source | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATA-OPS-001` | manifest | replay manifest | authoritative-control-plane | `ops-worker` | D1 + R2 | `job_id` | per job serial | operator-created | 标记来源、范围、书签、`export_epoch`、registry snapshot hash、source watermark 与允许的 restore / repair 模式。 |
| `DATA-OPS-002` | manifest | rebuild checkpoint | authoritative-control-plane | `jobs-worker` | D1 / DO SQLite | `{job_id,shard}` | per job serial | manifest | 用于断点续跑。 |
| `DATA-OPS-003` | manifest | repair decision log | authoritative-control-plane | `ops-worker` | D1 | `decision_id` | append-only | operator action | 记录人工修复与影响面。 |
| `DATA-OPS-004` | log | audit event log + idempotency registry | authoritative-control-plane | `ops-worker` | D1 + R2 immutable export | `{event_id}` | append-only source + strongly consistent dedupe lookup | periodic export | 记录 `operator_principal_id`、auth mechanism、scope、request_id、idempotency_key、request_fingerprint、causation_id、result、affected objects；控制面写操作必须先落此契约。 |

### 8.1 `DATA-OPS-004` 审计与幂等裁决规则

`DATA-OPS-004` 是控制面权威审计源，同时承担幂等裁决所需的强一致 lookup。逻辑上至少包含两类记录：

* append-only `audit_event`
* unique `request_dedupe_projection`

`audit_event` 的最小字段：

* `event_id`
* `event_type`
* `occurred_at`
* `operator_principal_id`
* `auth_mechanism`
* `scope`
* `request_id`
* `idempotency_key`
* `request_fingerprint`
* `job_id` 或 `causation_id`
* `result_code`
* `affected_objects`

`request_dedupe_projection` 的最小唯一键：

* `{operator_principal_id,idempotency_key,target_scope}`

并满足以下语义：

* 首次控制面写请求必须先在同一事务中写入 `accepted` 审计事件，并建立 dedupe projection，再开始副作用
* 若再次收到相同唯一键且 `request_fingerprint` 相同，必须返回同一 `job_id` 或同一终态结果
* 若再次收到相同唯一键但 `request_fingerprint` 不同，必须返回 idempotency conflict，不得静默覆盖
* 作业状态迁移必须继续追加 `audit_event`，而不是原地覆盖首条记录

## 9. 兼容与迁移规则

* DO SQLite schema 必须采用向前可读、向后可跳过字段的演进方式。
* D1 派生表允许 “drop and rebuild”，但前提是 rebuild path 已存在且经验证。
* Token 格式变更必须保留版本前缀，不得静默改变旧 token 解释。

## 10. 完成标准

* 所有关键真相面与派生面都已登记；
* token、cursor、idempotency 规则不再散落；
* 恢复与迁移有明确数据入口；
* 开发团队可据此开始 schema 与 keyspace 设计。
