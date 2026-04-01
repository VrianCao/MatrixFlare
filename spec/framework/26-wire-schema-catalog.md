# Wire Schema Catalog

状态：Draft-Normative
角色：线协议与 payload schema 总目录
负责主文档章节：3，6
扩展范围：本地 `/_ops`、内部 RPC、Queue、Alarm、固定错误体与 Matrix-native 逻辑契约的引接规则

## 1. 文档职责

* 为 [23-interface-contract-catalog.md](./23-interface-contract-catalog.md) 中出现的本地逻辑契约名提供唯一 wire schema 真相。
* 规定本地控制面、内部 RPC、队列负载、release-gate evidence attestation bundle 与固定错误体的字段、枚举、版本与演进规则。
* 防止“接口表里只有类型名，没有 payload shape”的灰区继续存在。

明确不包含：

* 不重复抄录 Matrix `v1.17` 官方公开路由的完整 request/response schema；
* 不定义持久化数据 schema；
* 不替代责任分册中的业务规则与状态机。

## 2. 权威边界与 Join 规则

* [23-interface-contract-catalog.md](./23-interface-contract-catalog.md) 中 `Input Contract` / `Output Contract` 列若写的是显式逻辑契约名，则该名称是本分册的 canonical join key。
* 若 `23` 中某个 `Input / Output` 单元格写的是 Matrix 官方 route family shorthand（例如 `request`、`query`、`room query`），则其 authority 直接回链到钉死的 Matrix `v1.17` route family，而不是把这些通用词当作本分册中的本地 schema 名。
* 若某逻辑契约对应 Matrix client-server / server-server / appservice 官方公开路由，则其权威 wire schema 仍来自钉死的 Matrix `v1.17` versioned spec；本分册只定义本项目额外收紧、固定 stub 或 route-family 归一化规则。
* 若某逻辑契约对应本地 `/_ops`、内部 RPC、Queue、Alarm 或固定错误体，则本分册是唯一 schema authority。
* 同一逻辑契约名不得在不同接口上承载两个不兼容 shape；若确有破坏性演进，必须引入新契约名或新 `schema_version` 主版本。

## 3. 全局编码、版本与演进规则

### 3.1 编码规则

* 本分册定义的本地 payload 一律为 UTF-8 JSON object；禁止 tuple-like positional array 作为顶层类型。
* JSON 字段名一律使用 `snake_case`。
* 时间戳一律使用 RFC 3339 UTC `Z` 结尾字符串。
* 哈希字段一律使用 `base64url(sha256(bytes))`，除非对应 Matrix 官方 schema 另有定义。

### 3.2 版本规则

* 所有 Queue payload 与跨 Worker 的长寿命异步作业 payload 都必须包含整数型 `schema_version`。
* `schema_version` 主版本不兼容时，consumer 必须 poison / reject，而不是猜测兼容。
* 同主版本下只允许 additive 变更；删除、重命名或改变字段语义都必须升级主版本。

### 3.3 Unknown Field 规则

* `/_ops` 写请求对未知顶层字段必须返回 `422`，防止审计与幂等指纹被“看不见的输入”污染。
* `/_ops` 读响应允许新增 additive 字段，但不得移除已发布字段。
* 内部 RPC 在 `schema_version` 主版本相同前提下可以忽略未知 additive 字段。
* Queue consumer 在 `schema_version` 主版本相同前提下可以忽略未知 additive 字段；若忽略后会影响幂等键、路由键或恢复语义，则必须 fail-closed。

### 3.4 共享字段约定

* `request_fingerprint`：对“接口语义已定义的 canonical request object”执行 RFC 8785 JCS 后再做 `sha256`。
* `idempotency_key`：直接来自调用方 header 或 control-plane request，不得在中途重写。
* `scope_kind` 只允许 `global`、`room_id`、`user_id`、`server_name`、`appservice_id`。
* `scope_id` 在 `scope_kind = global` 时必须为 `null`；其他情况必须为非空字符串。

## 4. 固定错误体 Contract

### 4.1 `MatrixUnrecognizedErrorBody`

| Field | Type | Rule |
| --- | --- | --- |
| `errcode` | string | 固定为 `M_UNRECOGNIZED` |
| `error` | string | 固定为 `Unrecognized or unsupported endpoint` |

适用面：

* `IF-CS-007`,`IF-CS-053`,`IF-CS-054`,`IF-CS-055`,`IF-CS-056`,`IF-CS-057`,`IF-CS-058`,`IF-CS-059`,`IF-CS-060`,`IF-CS-061`,`IF-CS-062`,`IF-CS-063`,`IF-CS-064`,`IF-CS-065`
* `IF-FED-010`

### 4.2 `MatrixUnknownTokenErrorBody`

| Field | Type | Rule |
| --- | --- | --- |
| `errcode` | string | 固定为 `M_UNKNOWN_TOKEN` |
| `error` | string | 固定为 `Unknown or unsupported token` |

适用面：

* `IF-FED-009`

附加规则：

* 联邦 stub 不得追加 client-session 语义字段，例如 `soft_logout`。

### 4.3 `OpsErrorResponse`

| Field | Type | Rule |
| --- | --- | --- |
| `code` | string | `unauthorized`,`forbidden`,`not_found`,`idempotency_conflict`,`validation_failed`,`precondition_failed`,`rate_limited`,`internal` |
| `message` | string | 人类可读错误摘要 |
| `request_id` | string | 控制面请求相关 ID |
| `retryable` | boolean | 是否建议调用方自动重试 |
| `details` | object or null | 可选结构化细节；不得泄漏 secret 或 token 材料 |

适用规则：

* [23-interface-contract-catalog.md](./23-interface-contract-catalog.md) 中所有 `typed ops error` 及其带显式 HTTP status 后缀的变体，都必须实例化为 `OpsErrorResponse`。
* 若 `Error Model` 写成 `typed ops error; 401/403/404/409/422` 之类形式，分号后的状态集合只约束允许返回的 HTTP status；响应体 shape 仍固定为 `OpsErrorResponse`。
* `OpsErrorResponse.code` 与 HTTP status 的默认映射固定如下：`unauthorized -> 401`，`forbidden -> 403`，`not_found -> 404`，`idempotency_conflict -> 409`，`precondition_failed -> 409`，`validation_failed -> 422`，`rate_limited -> 429`，`internal -> 500` 或 `503`（仅当 `retryable = true` 时允许 `503`）。

### 4.4 `InternalErrorEnvelope`

| Field | Type | Rule |
| --- | --- | --- |
| `code` | string | 由 owning spec 定义的稳定 typed error code |
| `message` | string | 人类可读摘要 |
| `retryable` | boolean | 是否允许自动重试 |
| `details` | object or null | 可选结构化字段；不得携带 secret、token 本体或大型 payload |

适用规则：

* [23-interface-contract-catalog.md](./23-interface-contract-catalog.md) 中所有 “typed auth/cursor/query/projection/delivery/internal error” 与 `retryable internal error` 默认都实例化为该 envelope。
* `code` 的枚举集合默认由本分册给出 canonical baseline；若 owning spec 需要进一步收紧或扩展，必须显式写出新增/删减后的集合。若两者都未定义，不得声称是 “typed error”。

#### 最小 `code` vocabulary

为避免不同实现各自发明错误码，首版最小稳定 `code` 集合固定如下：

* auth/session 类：`invalid_token`,`expired_session`,`deactivated_account`,`unknown_session`
* cursor/sync 类：`invalid_cursor`,`cursor_from_future`,`filter_mismatch`
* room admission 类：`auth_forbidden`,`state_conflict`,`missing_prev`,`soft_failed`
* room query/projection 类：`visibility_denied`,`archive_missing`,`invalid_range`
* key claim / to-device 类：`unsupported_algorithm`,`already_claimed`,`target_not_local`,`idempotency_conflict`
* federation internal 类：`duplicate_txn`,`payload_mismatch`,`retry_scheduled`
* control-plane / worker internal 类：`unsupported_schema_version`,`backpressure`,`job_conflict`,`not_current`
* media upload lifecycle 类：`quota_exceeded`,`pending_upload_limit_exceeded`,`upload_expired`,`pending_upload_missing`,`object_missing`

规则：

* owning spec 可以在不改变既有语义的前提下扩展枚举，但不得重载以上 code 的含义。
* 若 owning spec 未进一步收紧，默认适用下面的 “Error Model -> Allowed Codes” 绑定表。

#### 默认 `Error Model` 绑定表

| Error Model label in `23` | Allowed `code` set |
| --- | --- |
| `typed auth error` | `invalid_token`,`expired_session`,`deactivated_account`,`unknown_session` |
| `typed cursor error` | `invalid_cursor`,`cursor_from_future`,`filter_mismatch` |
| `typed auth/state error` | `auth_forbidden`,`state_conflict`,`missing_prev`,`soft_failed` |
| `typed projection error` | `visibility_denied`,`archive_missing`,`invalid_range` |
| `typed query error` | `visibility_denied`,`archive_missing`,`invalid_range` |
| `typed conflict/not-found` | `unsupported_algorithm`,`already_claimed`,`target_not_local` |
| `typed delivery error` | `unsupported_algorithm`,`target_not_local`,`idempotency_conflict` |
| `typed duplicate error / idempotency conflict` | `duplicate_txn`,`payload_mismatch` |
| `retryable internal error` | `retry_scheduled`,`backpressure`,`not_current` |
| `typed internal error` | `unsupported_schema_version`,`backpressure`,`job_conflict`,`not_current` |
| `typed quota error` | `quota_exceeded`,`pending_upload_limit_exceeded` |
| `typed finalize error` | `upload_expired`,`pending_upload_missing`,`object_missing` |

补充规则：

* 若 [23-interface-contract-catalog.md](./23-interface-contract-catalog.md) 中 `Error Model` 使用 `A / B` 这类复合写法，则允许的 `code` 集合是各分量标签映射结果的并集。
* 裸写的 `idempotency conflict` 只允许 `idempotency_conflict`。

## 5. 控制面与验证 Artifact Payload

### 5.1 共享类型

#### `TargetScope`

| Field | Type | Rule |
| --- | --- | --- |
| `scope_kind` | string | `global`,`room_id`,`user_id`,`server_name`,`appservice_id` |
| `scope_id` | string or null | `global` 时必须为 `null`，否则必须为非空 |

#### `JobHandle`

| Field | Type | Rule |
| --- | --- | --- |
| `job_id` | string | 全局唯一控制面作业 ID |
| `job_type` | string | `export`,`restore`,`rebuild`,`repair` |
| `state` | string | `accepted`,`queued`,`running`,`succeeded`,`failed`,`cancel_requested`,`canceled` |
| `scope` | `TargetScope` | 本次作业目标范围 |
| `accepted_at` | string | RFC 3339 UTC |
| `request_fingerprint` | string | canonical request hash |
| `idempotency_key_echo` | string | 原样回显 header 中的 `Idempotency-Key` |

#### `JobSummary`

| Field | Type | Rule |
| --- | --- | --- |
| `job_id` | string | 同 `JobHandle.job_id` |
| `job_type` | string | 同 `JobHandle.job_type` |
| `state` | string | 同 `JobHandle.state` |
| `scope` | `TargetScope` | 作业范围 |
| `created_at` | string | RFC 3339 UTC |
| `started_at` | string or null | RFC 3339 UTC |
| `completed_at` | string or null | RFC 3339 UTC |
| `progress` | object | 至少包含 `completed_units`,`total_units`,`unit_name` |
| `checkpoint_state` | object or null | 长作业 checkpoint 摘要 |
| `last_error` | `OpsErrorResponse` or null | 最近失败信息 |

#### 外部 `JobHandle.state` 与内部状态机映射

`JobHandle.state` / `JobSummary.state` 是对 [25-sequence-and-state-machine-catalog.md](./25-sequence-and-state-machine-catalog.md) 中内部 job state machine 的外部归一化投影，固定映射如下：

* `accepted`：内部状态 `pending`
* `queued`：内部状态 `checkpointed` 或任何已入队未执行状态
* `running`：内部状态 `scanning`,`applying`,`materializing`,`uploading`,`validating`,`importing`,`cutover-ready`,`cutover`,`verifying`
* `succeeded`：内部状态 `completed` 或 `finalized`
* `failed`：内部状态 `failed`
* `cancel_requested`：内部状态 `cancel_requested`
* `canceled`：内部状态 `canceled`

约束：

* 对外 API 只允许暴露归一化后的 `JobHandle.state`，不得把内部状态机名称直接泄漏为另一套并行真相。

### 5.2 `OpsHealthResponse`

| Field | Type | Rule |
| --- | --- | --- |
| `service` | string | 固定为 `ops-worker` |
| `status` | string | `ok`,`degraded`,`fail` |
| `observed_at` | string | RFC 3339 UTC |
| `worker_version_id` | string | 当前 Worker version ID |
| `deployment_id` | string | 当前 deployment ID |
| `compatibility_date` | string | 当前 compatibility date |
| `release_profile` | string | `L1`,`L2`,`L3` 之一 |
| `cpu_limit_class` | string | 当前 Worker 的显式 CPU limit class |
| `startup_time_ms` | integer | 当前 Worker 的启动校验耗时；若未采样则必须返回 `0` |
| `deployment_composition` | array | 当前 active deployment composition；每项至少包含 `worker_name`,`worker_version_id`,`deployment_id` |
| `feature_gates` | object | 当前启用/禁用的 feature gate 布尔值快照 |
| `secret_versions` | object | 仅允许返回 secret version 摘要；禁止返回 secret material，允许嵌套对象表达 signing/encryption active version |
| `dependencies` | array | 每项至少包含 `name`,`kind`,`status`,`detail` |

### 5.3 `ExportJobRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `export_mode` | string | `full_bundle` 或 `scoped_bundle` |
| `scope` | `TargetScope` | `full_bundle` 时必须为 `global` |
| `reason` | string | 非空变更原因 / 操作原因 |
| `ticket_id` | string or null | 外部工单号 |
| `reuse_checkpoint_policy` | string | `reuse_complete_if_cut_satisfied` 或 `force_fresh` |
| `max_checkpoint_age_seconds` | integer or null | 复用 checkpoint 的最大陈旧阈值 |
| `include_optional_objects` | boolean | 是否包含 `required_for_restore = false` 的对象 |
| `output_encryption_key_version` | string | 导出使用的加密 key version |

### 5.4 `RestoreJobRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `restore_mode` | string | `full_namespace` 或 `scoped_repair` |
| `scope` | `TargetScope` | `full_namespace` 时必须为 `global` |
| `reason` | string | 非空 |
| `ticket_id` | string or null | 外部工单号 |
| `source_bundle_uri` | string | 待恢复 bundle 的不可变定位符 |
| `source_bundle_hash` | string | bundle manifest hash |
| `target_environment_id` | string | 预先准备好的目标 namespace 集标识 |
| `allow_incomplete` | boolean | 默认 `false`；`full_namespace` 时必须为 `false` |
| `allowed_signing_key_versions` | array | restore allowlist |
| `allowed_encryption_key_versions` | array | decrypt allowlist |

### 5.5 `RebuildJobRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `rebuild_target` | string | `search_index`,`user_directory`,`public_room_directory`,`all_derived`,`appservice_projection` |
| `scope` | `TargetScope` | 重建范围 |
| `reason` | string | 非空 |
| `ticket_id` | string or null | 外部工单号 |
| `force_full_scan` | boolean | 是否禁用增量/fast path |

### 5.6 `RepairJobRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `repair_kind` | string | `room_graph`,`room_user_fanout`,`user_device_keys`,`remote_server_txn_queue`,`remote_media_catalog`,`search_reindex` |
| `scope` | `TargetScope` | 必须与 `repair_kind` 相容 |
| `reason` | string | 非空 |
| `ticket_id` | string or null | 外部工单号 |
| `dry_run` | boolean | `true` 时只允许产出 repair plan，不得改写真相 |
| `source_bundle_uri` | string or null | 若修复依赖外部导出包，则必须显式给出 |

### 5.7 `JobStatusQuery`

| Field | Type | Rule |
| --- | --- | --- |
| `job_id` | string or null | 精确查询时使用 |
| `job_type` | string or null | 列表查询过滤 |
| `state` | string or null | 列表查询过滤 |
| `scope` | `TargetScope` or null | 列表查询过滤 |
| `limit` | integer or null | 默认值由实现设定，但必须有上限 |
| `cursor` | string or null | 列表分页游标 |

约束：

* `job_id` 非空时，`job_type`、`state`、`scope`、`cursor` 必须为 `null`。

### 5.8 `JobStatusResponse`

| Field | Type | Rule |
| --- | --- | --- |
| `job` | `JobSummary` or null | 精确查询时返回 |
| `jobs` | array or null | 列表查询时返回 `JobSummary[]` |
| `next_cursor` | string or null | 仅列表查询可返回 |

约束：

* `job` 与 `jobs` 必须二选一，禁止同时非空。

### 5.9 `JobCancelRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `reason` | string | 非空 |
| `ticket_id` | string or null | 外部工单号 |
| `if_in_states` | array or null | 若非空，仅当当前 state 在该集合中才接受取消 |

### 5.10 `JobCancelResponse`

| Field | Type | Rule |
| --- | --- | --- |
| `job_id` | string | 被取消作业 ID |
| `previous_state` | string | 取消前状态 |
| `new_state` | string | `cancel_requested` 或 `canceled` |
| `accepted_at` | string | RFC 3339 UTC |

### 5.11 `AppserviceNamespaceRule`

| Field | Type | Rule |
| --- | --- | --- |
| `regex` | string | namespace 匹配规则 |
| `exclusive` | boolean | 是否排他 |

### 5.12 `AppserviceDescriptor`

| Field | Type | Rule |
| --- | --- | --- |
| `appservice_id` | string | 全局唯一 appservice 标识 |
| `url` | string | AS 接收事务与查询的基准 URL |
| `sender_localpart` | string | AS 发送者 localpart |
| `hs_token_secret_ref` | string | homeserver token 的 secret ref，禁止明文返回 |
| `as_token_secret_ref` | string | appservice token 的 secret ref，禁止明文返回 |
| `namespaces` | object | `users`,`aliases`,`rooms` 三个数组，元素为 `AppserviceNamespaceRule` |
| `protocols` | array | 可选 third-party protocol 声明 |
| `rate_limited` | boolean | 是否启用 AS 级限流 |
| `receive_ephemeral` | boolean | 是否接收 ephemeral payload |
| `healthcheck_enabled` | boolean | 是否纳入健康检查 |
| `disabled_at` | string or null | 非空表示逻辑停用 |
| `delivery_state` | object | 至少包含 `last_success_at`,`backlog_depth`,`retry_state`,`last_error` |

### 5.13 `AppserviceConfigRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `appservice` | `AppserviceDescriptor` | `POST` / `PUT` 时必填；`GET` / `DELETE` 时为空 |
| `ticket_id` | string or null | 当命中的 operator policy 要求 ticket 时必填 |

### 5.14 `AppserviceConfigResponse`

| Field | Type | Rule |
| --- | --- | --- |
| `appservice` | `AppserviceDescriptor` or null | 单项读取/写入返回 |
| `appservices` | array or null | 列表读取返回 `AppserviceDescriptor[]` |
| `next_cursor` | string or null | 列表分页游标 |

以下 `5.15-5.21` 不是公开 Matrix route 或 `/_ops` HTTP body，而是 release-gate evidence import 时允许出现的本地 machine-readable artifact contract。它们仍属于本分册 authority，避免 provenance 语义散落在自由 JSON 中。

### 5.15 `CloudflareResourceSnapshot`

| Field | Type | Rule |
| --- | --- | --- |
| `workers` | array | 非空字符串数组；至少标识 active Worker version / deployment composition |
| `durable_objects` | array | 非空字符串数组 |
| `d1_databases` | array | 非空字符串数组 |
| `r2_buckets` | array | 非空字符串数组 |
| `kv_namespaces` | array | 非空字符串数组 |
| `queues` | array | 非空字符串数组 |

适用面：

* `EnvironmentRunReport`
* `ProdCostSnapshot`

### 5.16 `EnvironmentRunReport`

| Field | Type | Rule |
| --- | --- | --- |
| `environment_name` | string | `ci-integration`,`staging`,`pre-release` 之一 |
| `run_timestamp` | string | evidence run timestamp，格式见 `44` |
| `status` | string | release-gate 证据只允许 `pass` |
| `exit_code` | integer | release-gate 证据只允许 `0` |
| `started_at` | string | RFC 3339 UTC |
| `completed_at` | string | RFC 3339 UTC |
| `duration_ms` | integer | 非负 |
| `command` | string | 非空；执行命令审计快照 |
| `test_directory` | string | 必须与环境目录一致，例如 `tests/staging` |
| `test_file_count` | integer | 正整数 |
| `test_files` | array | 相对仓库路径；长度必须与 `test_file_count` 一致 |
| `expanded_test_file_count` | integer | 正整数 |
| `expanded_test_files` | array | 相对仓库路径；长度必须与 `expanded_test_file_count` 一致，且 release-gate 证据不得包含 `tests/local/*` |
| `output_sha256` | string | 64 字符小写 hex；对应本次执行组合输出摘要 |
| `error_message` | string or null | `pass` 时必须为 `null` |
| `log_artifact` | string | 非空；外部日志工件定位符 |
| `executed_by` | string | 非空执行者标识 |
| `reviewed_by` | string | 非空审查者标识 |
| `source_run_uri` | string | 绝对外部 URI / locator；必须具 authority，或使用格式完整的 `urn:<nid>:<nss>`；不得为裸 `urn:`，且不得为 `about:` / `blob:` / `file:` / `data:` / `javascript:` |
| `topology_kind` | string | 非本地拓扑标识；不得为 `local` |
| `cloudflare_resources` | `CloudflareResourceSnapshot` | 本次执行所绑定资源快照 |

### 5.17 `ProdCostSnapshot`

| Field | Type | Rule |
| --- | --- | --- |
| `artifact_id` | string | 固定为 `prod_cost_snapshot` |
| `source_environment` | string | 固定为 `prod` |
| `run_timestamp` | string | evidence run timestamp |
| `captured_at` | string | RFC 3339 UTC |
| `captured_by` | string | 非空执行者标识 |
| `reviewed_by` | string | 非空审查者标识 |
| `source_dashboard_uri` | string | 绝对外部 URI / locator；必须具 authority，或使用格式完整的 `urn:<nid>:<nss>`；不得为裸 `urn:`，且不得为 `about:` / `blob:` / `file:` / `data:` / `javascript:` |
| `topology_kind` | string | 非本地拓扑标识；不得为 `local` |
| `cloudflare_resources` | `CloudflareResourceSnapshot` | 生产资源快照 |
| `billing_period` | object | 必须包含 `start`,`end` RFC 3339 UTC，且 `start <= end` |
| `cost_surfaces` | object | 至少包含 `workers`,`durable_objects`,`d1`,`r2`,`kv`,`queues`，每个子对象字段见 `44` 对应成本门禁语义 |
| `model_comparison` | object | 至少包含 `status`,`summary`,`actual_total_usd`,`modeled_total_usd`,`drift_ratio` |

### 5.18 `EvidenceDeploymentIdentity`

| Field | Type | Rule |
| --- | --- | --- |
| `environment_id` | string | 非空；目标环境的稳定标识 |
| `deployment_ids` | array | 非空字符串数组；必须能回链到该次执行或采样时有效的 deployment 记录 |
| `worker_version_ids` | array | 非空字符串数组；必须能回链到 active Worker version 记录 |

### 5.19 `EvidenceProvenance`

| Field | Type | Rule |
| --- | --- | --- |
| `origin_system` | string | 非空；产出 attestation 的 workflow / capture system 名称 |
| `origin_run_id` | string | 非空；workflow / capture run ID |
| `origin_run_attempt` | integer | 正整数；同一 run 的重试序号 |
| `origin_run_uri` | string | 绝对外部 URI / locator；必须具 authority，或使用格式完整的 `urn:<nid>:<nss>`；不得为裸 `urn:`，且不得为 `about:` / `blob:` / `file:` / `data:` / `javascript:` |
| `artifact_store_uri` | string | 绝对外部 URI / locator；必须具 authority，或使用格式完整的 `urn:<nid>:<nss>`；不得为裸 `urn:`，且不得为 `about:` / `blob:` / `file:` / `data:` / `javascript:` |
| `artifact_store_key` | string | 非空；对象键或等价 immutable locator。对 Phase 08 GitHub Actions + R2 provenance，必须编码为 `gha/<origin_run_id>/<origin_run_attempt>/<source_environment>/<run_timestamp>/...` |
| `artifact_sha256` | string | 64 字符小写 hex；对应外部原始工件摘要 |
| `review_record_uri` | string | 绝对外部 URI / locator；必须具 authority，或使用格式完整的 `urn:<nid>:<nss>`；不得为裸 `urn:`，且不得为 `about:` / `blob:` / `file:` / `data:` / `javascript:` |
| `topology_kind` | string | 非本地拓扑标识；不得为 `local` |
| `deployment_identity` | `EvidenceDeploymentIdentity` | 该次执行或采样对应的 deployment 身份 |

### 5.20 `EnvironmentRunAttestation`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 固定为 `1` |
| `artifact_id` | string | `ci_integration_run_report`,`staging_run_report`,`pre_release_run_report` 之一 |
| `attestation_kind` | string | 固定为 `environment_run` |
| `source_environment` | string | `ci-integration`,`staging`,`pre-release` 之一，且必须与 `artifact_id` 一致 |
| `run_timestamp` | string | 必须与 `payload.run_timestamp` 一致 |
| `attested_at` | string | RFC 3339 UTC |
| `provenance` | `EvidenceProvenance` | 不得省略 |
| `payload` | `EnvironmentRunReport` | 不得省略；`payload.environment_name` 与 `source_environment` 必须一致，`payload.source_run_uri` 必须与 `provenance.origin_run_uri` 一致，`payload.topology_kind` 必须与 `provenance.topology_kind` 一致 |

附加规则：

* release-gate evidence 只接受 `EnvironmentRunAttestation`，不得直接接受裸 `EnvironmentRunReport`。
* 若 `payload.expanded_test_files` 触及 `tests/local/*`、存在 repo boundary escape、或存在 unresolved dynamic import，consumer 必须 fail-closed。

### 5.21 `ProdCostSnapshotAttestation`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 固定为 `1` |
| `artifact_id` | string | 固定为 `prod_cost_snapshot` |
| `attestation_kind` | string | 固定为 `prod_cost_snapshot` |
| `source_environment` | string | 固定为 `prod` |
| `run_timestamp` | string | 必须与 `payload.run_timestamp` 一致 |
| `attested_at` | string | RFC 3339 UTC |
| `provenance` | `EvidenceProvenance` | 不得省略 |
| `payload` | `ProdCostSnapshot` | 不得省略；`payload.topology_kind` 必须与 `provenance.topology_kind` 一致 |

附加规则：

* release-gate evidence 只接受 `ProdCostSnapshotAttestation`，不得直接接受裸 `ProdCostSnapshot`。
* 若 attestation 缺少 audited artifact reference、review record 或 deployment identity，consumer 必须 fail-closed。

## 6. 内部 RPC 与异步作业 Payload

* 除显式采用 stream 或 locator 的契约外，任何内部 RPC request/response 的普通 serialized payload 都必须小于等于 `32 MiB`；更大的数据必须分页、分段或外置到 R2 后只传 locator。引用：`CF-WKR-023`。

### 6.1 通用 ACK 类型

#### `Ack`

| Field | Type | Rule |
| --- | --- | --- |
| `accepted` | boolean | 是否接受该请求 |
| `accepted_at` | string | RFC 3339 UTC |
| `dedupe_key` | string or null | 若适用，回显实际使用的幂等键 |

#### `AppendAck`

| Field | Type | Rule |
| --- | --- | --- |
| `accepted` | boolean | 是否已 durable 追加 |
| `accepted_at` | string | RFC 3339 UTC |
| `durable_stream_pos` | integer | 目标流上的 durable 位置 |

#### `QueueAck`

| Field | Type | Rule |
| --- | --- | --- |
| `accepted` | boolean | 是否已 durable 入队 |
| `accepted_at` | string | RFC 3339 UTC |
| `server_name` | string | 目标远端 server |
| `queue_seq` | integer | 远端队列顺序号 |

#### `ExportShardAck`

| Field | Type | Rule |
| --- | --- | --- |
| `accepted` | boolean | 是否接受该 shard 导出 |
| `accepted_at` | string | RFC 3339 UTC |
| `job_id` | string | 控制面作业 ID |
| `shard_type` | string | `UserDO`,`RoomDO`,`RemoteServerDO` 之一 |
| `shard_key` | string | 该 shard 的 canonical key |
| `checkpoint_id` | string or null | 若已分配 checkpoint，则返回 |

### 6.2 会话、同步、用户与房间 RPC

#### `AccessTokenEnvelope`

| Field | Type | Rule |
| --- | --- | --- |
| `access_token_hash` | string | 已哈希，不传明文 |
| `presented_at` | string | RFC 3339 UTC |

#### `SessionContext`

| Field | Type | Rule |
| --- | --- | --- |
| `user_id` | string | 本地用户 ID |
| `device_id` | string or null | 设备 ID |
| `session_id` | string | 会话 ID |
| `auth_version` | integer | 必须与 `DATA-USER-017.auth_version` 对齐 |
| `session_epoch` | integer | 必须与 `user_runtime_state.session_epoch` 对齐 |
| `is_guest` | boolean | 访客标记 |
| `expires_at` | string or null | 过期时间 |

#### `SyncCursorRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `user_id` | string | 发起用户 |
| `session_id` | string | 当前会话 |
| `since_token` | string or null | 上次 `next_batch` |
| `filter_hash` | string | canonical filter hash |
| `full_state` | boolean | 是否 full-state |
| `use_state_after` | boolean | 是否启用相关行为 |
| `timeout_ms` | integer | long-poll 超时上限 |

#### `UserStreamDeltaBatch`

| Field | Type | Rule |
| --- | --- | --- |
| `user_id` | string | 所属用户 |
| `from_stream_pos` | integer | 起始位置 |
| `to_stream_pos` | integer | 结束位置 |
| `entries` | array | 用户流增量条目 |
| `limited` | boolean | 是否触发 limited |

#### `KeyClaimQuery`

| Field | Type | Rule |
| --- | --- | --- |
| `target_user_id` | string | 目标本地用户 |
| `device_queries` | array | 每项至少含 `device_id`,`algorithm`,`count` |

#### `ClaimedKeyBatch`

| Field | Type | Rule |
| --- | --- | --- |
| `target_user_id` | string | 目标本地用户 |
| `claimed_keys` | array | 每项至少含 `device_id`,`algorithm`,`key_id`,`key_json` |
| `fallback_key_counts` | object | algorithm -> remaining count |

#### `ToDeviceEnqueueRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `sender_user_id` | string | 发送者 |
| `event_type` | string | to-device 类型 |
| `txn_id` | string | 公共事务键 |
| `request_fingerprint` | string | 与 3.4 共享定义一致 |
| `messages` | object | `target_user_id -> target_device_id -> content` |

#### `RoomFanoutDelta`

| Field | Type | Rule |
| --- | --- | --- |
| `room_id` | string | 房间 ID |
| `room_pos` | integer | committed room position |
| `user_id` | string | 目标本地用户 |
| `membership_bucket` | string | 供 `/sync` 投影使用 |
| `stream_entries` | array | 要写入用户流的条目 |
| `notification_delta` | object | unread / highlight 增量 |

#### `EventAdmissionRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `room_id` | string | 目标房间 |
| `request_kind` | string | `client`,`federation`,`repair`,`backfill` |
| `candidate_event` | object | canonical event JSON |
| `request_fingerprint` | string | admission 请求 hash |

#### `EventAdmissionResult`

| Field | Type | Rule |
| --- | --- | --- |
| `decision` | string | `accepted`,`rejected`,`waiting_missing` |
| `event_id` | string or null | 被接纳事件 ID |
| `room_pos` | integer or null | committed room position |
| `snapshot_id` | integer or null | 相关 snapshot |
| `error_code` | string or null | 拒绝时的 typed error code |

#### `RoomProjectionRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `user_id` | string | 请求者 |
| `room_id` | string | 房间 ID |
| `room_pos` | integer | 投影截止位置 |
| `membership_bucket` | string | 参与可见性裁决 |
| `filter_hash` | string | canonical filter hash |
| `visibility_context` | object | 不得省略 |

#### `RoomSyncProjection`

| Field | Type | Rule |
| --- | --- | --- |
| `room_id` | string | 房间 ID |
| `room_pos` | integer | 对应位置 |
| `timeline` | array | `/sync` timeline 片段 |
| `state` | array | state delta |
| `ephemeral` | array | ephemeral 项 |
| `limited` | boolean | 是否 limited |

#### `RoomReadRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `kind` | string | `timeline`,`context`,`event`,`state`,`members`,`joined_members`,`relations`,`threads`,`timestamp_lookup` |
| `room_id` | string | 房间 ID |
| `requester_user_id` | string | 请求用户 |
| `cursor` | object or null | timeline / pagination 上下文 |
| `event_id` | string or null | event/context/relations 使用 |
| `timestamp` | integer or null | `timestamp_lookup` 使用 |
| `limit` | integer or null | 可选限制 |

#### `RoomReadResult`

| Field | Type | Rule |
| --- | --- | --- |
| `kind` | string | 与 request 对齐 |
| `room_id` | string | 房间 ID |
| `chunk` | array | timeline / relations / threads 结果 |
| `state` | array | state 结果 |
| `event` | object or null | 单事件结果 |
| `start` | string or null | 起始游标 |
| `end` | string or null | 结束游标 |

#### `MediaUploadIntent`

| Field | Type | Rule |
| --- | --- | --- |
| `user_id` | string | 上传用户 |
| `device_id` | string or null | 上传设备 |
| `filename` | string or null | 原始文件名 |
| `content_type` | string | MIME |
| `declared_size` | integer | 客户端声明字节数 |
| `sha256` | string or null | 若客户端已知可带上 |
| `media_id` | string or null | `upload-by-ID` 时必须是 `create` 预留出的本地 media ID |
| `reservation_only` | boolean | `true` 时只创建 pending grant，不写 R2 |
| `require_existing` | boolean | `true` 时必须复用已存在的 pending grant，不得隐式新建 |

#### `PendingUploadGrant`

| Field | Type | Rule |
| --- | --- | --- |
| `pending_upload_id` | string | 上传授权 ID |
| `max_bytes` | integer | 本次允许的最大字节数 |
| `allowed_content_types` | array | 允许 MIME 集 |
| `expires_at` | string | 授权过期时间 |
| `media_id` | string | 与本次授权绑定的本地 media ID |
| `mxc_uri` | string | 对应的本地 `mxc://server/media_id` |

#### `MediaFinalizeRequest`

| Field | Type | Rule |
| --- | --- | --- |
| `pending_upload_id` | string | 上传授权 ID |
| `finalize_state` | string | `completed`,`reverted`,`orphaned` 之一 |
| `r2_object_key` | string or null | `completed` / `orphaned` 时为对象键，`reverted` 时可省略 |
| `byte_size` | integer or null | `completed` 时必须带实际大小 |
| `content_type` | string or null | `completed` 时必须带实际 MIME |
| `sha256` | string or null | `completed` 时必须带对象 hash |
| `error_message` | string or null | `reverted` / `orphaned` 时应带失败原因 |
| `upload_completed_at` | string | RFC 3339 UTC |

#### `MediaFinalizeAck`

| Field | Type | Rule |
| --- | --- | --- |
| `mxc_uri` | string | 最终 MXC |
| `media_id` | string | 本地 media ID |
| `catalog_visibility` | string | `pending` 或 `visible` |
| `thumbnail_job_enqueued` | boolean | 是否已投递缩略图作业 |

### 6.3 联邦内部 Payload

#### `OutboundTxnIntent`

| Field | Type | Rule |
| --- | --- | --- |
| `server_name` | string | 目标远端服务器 |
| `txn_scope` | string | `pdu`,`edu`,`mixed` |
| `origin_kind` | string | `room`,`user` |
| `event_or_edu_ids` | array | 本次 intent 覆盖的逻辑单元 ID |
| `payload_ref` | string or null | 若 payload 已外置，可给出 locator |
| `not_before` | string or null | 最早发送时间 |

#### `InboundTxnEnvelope`

| Field | Type | Rule |
| --- | --- | --- |
| `origin` | string | 远端服务器名 |
| `txn_id` | string | 远端事务 ID |
| `dedupe_request_hash` | string | 已验证后 transaction body 的内部去重 hash；按 RFC 8785 JCS 计算，不得与 Matrix 事件 canonical JSON 概念混用 |
| `received_at` | string | RFC 3339 UTC |
| `pdu_count` | integer | PDU 数量 |
| `edu_count` | integer | EDU 数量 |

#### `TxnDedupeResult`

| Field | Type | Rule |
| --- | --- | --- |
| `decision` | string | `proceed`,`cached_result`,`conflict_payload_mismatch` |
| `canonical_response` | object or null | 若可直接返回缓存，则给出 |

### 6.4 控制面跨 Worker Job Spec

以下四类 payload 都继承共同字段：

* `schema_version`
* `job_id`
* `scope`
* `operator_principal_id`
* `reason`
* `accepted_at`
* `request_fingerprint`

#### `RebuildJobSpec`

附加字段：

* `rebuild_target`
* `force_full_scan`

#### `ExportJobSpec`

附加字段：

* `export_mode`
* `reuse_checkpoint_policy`
* `max_checkpoint_age_seconds`
* `include_optional_objects`
* `output_encryption_key_version`
* `registry_snapshot_id`
* `export_epoch`

#### `RestoreJobSpec`

附加字段：

* `restore_mode`
* `source_bundle_uri`
* `source_bundle_hash`
* `target_environment_id`
* `allow_incomplete`
* `allowed_signing_key_versions`
* `allowed_encryption_key_versions`

#### `RepairJobSpec`

附加字段：

* `repair_kind`
* `dry_run`
* `source_bundle_uri`

#### `UserExportSpec`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `job_id` | string | 控制面作业 ID |
| `shard_type` | string | 固定为 `UserDO` |
| `shard_key` | string | 用户 shard key |
| `registry_snapshot_id` | string or null | full export 时必须非空 |
| `export_epoch` | string or null | full export 时必须非空 |
| `checkpoint_strategy` | string | `reuse_complete` 或 `force_fresh` |

#### `RoomExportSpec`

与 `UserExportSpec` 同 shape，但 `shard_type` 固定为 `RoomDO`。

#### `RemoteQueueExportSpec`

与 `UserExportSpec` 同 shape，但 `shard_type` 固定为 `RemoteServerDO`。

### 6.5 Queue Payload

#### `DerivedWorkBatch`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `batch_id` | string | 批次 ID |
| `requested_by` | string | 触发方组件 |
| `work_items` | array | 每项至少含 `work_type`,`scope`,`idempotency_key`,`source_refs` |

#### `SearchIndexJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `event_id` | string | 幂等主键 |
| `room_id` | string | 事件所在房间 |
| `room_pos` | integer | committed order |
| `visibility_watermark` | integer | 可见性相关水位 |
| `redaction_watermark` | integer | redaction 相关水位 |
| `enqueued_at` | string | RFC 3339 UTC |

#### `ThumbnailJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `mxc_uri` | string | 目标媒体 |
| `source_kind` | string | `local` 或 `remote_cache` |
| `r2_object_key` | string | 源对象键 |
| `variants` | array | 每项至少含 `width`,`height`,`method` |
| `content_type` | string | 原对象 MIME |
| `enqueued_at` | string | RFC 3339 UTC |

#### `AppserviceTxnJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `appservice_id` | string | 目标 AS |
| `txn_id` | integer | HS->AS 事务号 |
| `payload_locator` | string | 事务 payload 定位符 |
| `not_before` | string or null | 最早投递时间 |
| `attempt` | integer | 当前尝试次数 |

#### `RebuildShardJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `job_id` | string | 控制面作业 ID |
| `rebuild_target` | string | 与 `RebuildJobSpec` 对齐 |
| `shard_type` | string | shard 类型 |
| `shard_key` | string | shard key |
| `attempt` | integer | 当前尝试次数 |

#### `ExportShardJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `job_id` | string | 控制面作业 ID |
| `export_epoch` | string | full export 时必须非空 |
| `shard_type` | string | shard 类型 |
| `shard_key` | string | shard key |
| `checkpoint_strategy` | string | `reuse_complete` 或 `force_fresh` |
| `attempt` | integer | 当前尝试次数 |

#### `RestoreShardJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `job_id` | string | 控制面作业 ID |
| `checkpoint_id` | string | 待恢复 checkpoint |
| `shard_type` | string | shard 类型 |
| `shard_key` | string | shard key |
| `apply_phase` | string | `truth-core`,`truth-aux`,`ephemeral-current`,`dedupe-and-outbox`,`control-plane` |
| `attempt` | integer | 当前尝试次数 |

#### `RepairShardJob`

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | integer | 当前主版本 |
| `job_id` | string | 控制面作业 ID |
| `repair_kind` | string | 与 `RepairJobSpec` 对齐 |
| `scope_kind` | string | 与 `TargetScope.scope_kind` 对齐 |
| `scope_id` | string or null | 与 `TargetScope.scope_id` 对齐 |
| `attempt` | integer | 当前尝试次数 |

## 7. 完成标准

* `23-interface-contract-catalog.md` 中本地逻辑契约名不再只是“名字”；
* 控制面 HTTP、内部 RPC、Queue payload 都有可编码的最小字段集；
* fixed stub/error body 已有唯一 wire truth；
* 开发团队可以据此生成 request validator、worker RPC DTO、queue consumer schema 与类型定义。
