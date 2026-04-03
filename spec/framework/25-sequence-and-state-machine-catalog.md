# Sequence and State Machine Catalog

状态：Draft-Normative
角色：流程与状态机目录  
负责主文档章节：3，4，6，7  
扩展范围：所有关键行为流程

## 1. 文档职责

* 规定哪些关键流程必须有时序图，哪些关键对象必须有状态机。
* 防止复杂行为只用散文描述，导致实现偏差。
* 为测试设计和故障分析提供统一行为模型入口。

## 2. 时序图目录

### 2.1 客户端与身份域

| FLOW ID | Name | Owning Spec | Participants | Trigger | Success Path | Failure / Retry Path |
| --- | --- | --- | --- | --- | --- | --- |
| `FLOW-CS-DISCOVERY` | client discovery | `30` | client, `gateway-worker` | `GET /.well-known/matrix/client`, `GET /_matrix/client/versions`, or `GET /_matrix/client/*/capabilities` | 返回能力与 homeserver 元数据 | 静态错误或缓存回退 |
| `FLOW-CS-UIA` | shared UIA challenge orchestration | `30`,`40` | client, `gateway-worker`, optional `UserDO` | `register`, `account/password`, `account/deactivate`, or other enabled UIA endpoint | 发行 route-bound challenge token、校验 stage、在最终提交前把 challenge 绑定到同一路由与同一主体 | challenge 过期、路由绑定不匹配、主体漂移或 completed stage 重放必须 fail-closed，不得落盘部分业务结果 |
| `FLOW-CS-REGISTER` | registration | `30` | client, `gateway-worker`, `UserDO` | `POST /register` | 创建用户、初始设备、初始 session | 保持幂等错误响应，不做半创建 |
| `FLOW-CS-LOGIN` | login | `30` | client, `gateway-worker`, `UserDO` | `POST /login` | 认证、创建设备 session、返回 token | 失败不创建任何 session |
| `FLOW-CS-DEVICE-MANAGEMENT` | device metadata read/update/delete | `30` | client, `gateway-worker`, `UserDO` | `GET/PUT/DELETE /devices`, `POST /delete_devices` | 读取/更新当前用户 device metadata；delete 路径经 UIA 后原子撤销 device 相关 session 与 key truth | device 不存在返回稳定 not-found；delete 的 UIA mismatch 或 replay 冲突必须 fail-closed，不得留下半删除状态 |
| `FLOW-CS-PASSWORD-CHANGE` | password change | `30`,`40` | client, `gateway-worker`, `UserDO` | `POST /account/password` | 先完成 UIA，再原子更新 password credential / `auth_version`，并按 `logout_devices` 裁决其他 session 与 device | 任一 UIA、credential 校验或 session/device 后处理失败都不得留下半更新密码状态 |
| `FLOW-CS-ACCOUNT-DEACTIVATE` | account deactivation | `30`,`40` | client, `gateway-worker`, `UserDO`, optional `jobs-worker` | `POST /account/deactivate` | 先完成 UIA，再原子标记 deactivated、撤销登录能力、清理本地非事件数据，并返回稳定 `id_server_unbind_result` | 任一失败都不得出现“密码已失效但账户未停用”或“停用已提交但仍可登录”的裂脑状态 |
| `FLOW-CS-REFRESH` | refresh token | `30` | client, `gateway-worker`, `UserDO` | `POST /refresh` | 校验 refresh token、轮换 session | refresh 重放必须失败或返回已轮换结果 |
| `FLOW-CS-PROFILE-PROPAGATION` | profile update propagation | `30`,`31` | client, `gateway-worker`, `UserDO`, `RoomDO`, optional `jobs-worker` | `PUT` or `DELETE /_matrix/client/*/profile/{userId}/{keyName}` | 更新 profile 真相；仅当 `keyName ∈ {displayname,avatar_url}` 时发出 presence 增量并对已加入房间传播 membership refresh | 不得产生半更新；传播重试必须按 profile version 幂等 |
| `FLOW-CS-SYNC-LONGPOLL` | sync long poll | `30` | client, `gateway-worker`, `UserDO`, `RoomDO` | `GET /sync` | Worker 持有请求，收到唤醒后组装响应 | 通道断开早返回；不得推进 token |
| `FLOW-CS-SEND-TO-DEVICE` | send to-device | `30` | client, `gateway-worker`, `UserDO`, optional `RemoteServerDO` | `PUT /sendToDevice` | 写本地队列并派发远端 EDU | 远端失败不影响本地提交 |
| `FLOW-CS-SEARCH-QUERY` | search and derived read query | `34` | client, `gateway-worker`, D1, optional `RoomDO`, optional `UserDO` | `/search`, `/user_directory/search`, `publicRooms`, or client hierarchy request | 读取 D1 derived plane 并在可见性不确定时回退 truth 或 fail-closed | derived 滞后、目录 watermark 落后或可见性不确定时不得猜测公开结果 |
| `FLOW-CS-DISABLED-ROUTE` | explicit disabled/deferred client route | `12`,`23` | client, `gateway-worker` | deferred, disabled, or explicitly unsupported public client route | 返回固定 unsupported response，且不得产生任何 authority or side-effect write；若该能力在 `GET /login` 或 `GET /capabilities` 有 discoverability 面，则 discoverability 也必须同步维持 disabled truth | 实现漂移、误接通下游 handler、discoverability 与 route truth 不一致、或出现副作用都必须视为失败 |

### 2.2 房间域

| FLOW ID | Name | Owning Spec | Participants | Trigger | Success Path | Failure / Retry Path |
| --- | --- | --- | --- | --- | --- | --- |
| `FLOW-CS-SEND-EVENT` | local event send | `31` | client, `gateway-worker`, `UserDO`, `RoomDO` | `PUT /rooms/.../send` | `RoomDO` 幂等裁决、准入、提交、fanout | 校验失败原子拒绝；同 `txnId` 重试要么返回同结果，要么 deterministic conflict |
| `FLOW-CS-ROOM-MEMBERSHIP` | membership mutation | `31` | client, `gateway-worker`, `UserDO`, `RoomDO`, optional federation | join/invite/leave/ban/knock | 生成 membership event 并走同一准入管道 | 联邦握手失败不得伪造本地成功 |
| `FLOW-CS-ROOM-QUERY` | room history and state query | `31` | client, `gateway-worker`, `RoomDO` | `/messages`, `/context`, `/event`, `/state`, `/members`, `/joined_members`, `/relations`, `/threads`, `/timestamp_to_event` | `gateway-worker` 规范化为 `RoomReadRequest`，`RoomDO` 按 query kind、索引与归档指针裁决可见性后返回房间读结果 | cursor 无效、时间定位失败、冷归档缺段或可见性不满足时 fail-closed，不得改写真相 |
| `FLOW-ROOM-EVENT-ADMISSION` | unified room admission | `31` | `gateway-worker`, `RoomDO`, `UserDO`, `RemoteServerDO` | local/fed/AS event ingress | 统一 auth/state resolution/commit | 失败不产生 partial state |
| `FLOW-ROOM-LOCAL-FANOUT` | local user fanout | `31` | `RoomDO`, `UserDO`, `jobs-worker` | room commit success | `RoomDO` 写 durable outbox，`UserDO` durable append 到用户流并返回 ack，随后 GC outbox 并推送索引任务 | 单用户失败必须保留 outbox 并补偿重试；必要时进入 repair |
| `FLOW-ROOM-FANOUT-REPAIR` | room-to-user fanout reconciliation | `31`,`42` | `ops-worker`, `jobs-worker`, `RoomDO`, `UserDO` | periodic audit or scoped repair | 以 `DATA-ROOM-011` 与 `DATA-USER-010` 交叉核对，重投缺失 append、补记 ack 或生成 repair 决议 | 发现归属不清、event truth 缺失或重复冲突时必须写 `DATA-OPS-003`,`DATA-OPS-004` 并 bounded retry |

### 2.3 联邦域

| FLOW ID | Name | Owning Spec | Participants | Trigger | Success Path | Failure / Retry Path |
| --- | --- | --- | --- | --- | --- | --- |
| `FLOW-FED-DISCOVERY` | remote server discovery | `32` | `gateway-worker`, DNS, remote server | outbound federation call | 依 Matrix 发现流程得到目标地址 | 失败缓存按 TTL 失效并重试 |
| `FLOW-FED-METADATA-SERVE` | federation metadata serve | `32` | remote server, `gateway-worker`, optional `RemoteServerDO` | remote request for `/.well-known/matrix/server`, `/_matrix/federation/*/version`, or server key material | 返回本地 discovery / version / signing-key metadata，并保持与当前发布 keyset 一致 | keyset 轮换窗口、缓存副本漂移或签名材料不可用时必须 fail-closed |
| `FLOW-FED-QUERY` | federation query surfaces | `32`,`34` | remote server, `gateway-worker`, `UserDO`, `RoomDO`, `jobs-worker`, D1 | `publicRooms`, hierarchy, directory, profile, or generic federation query request | 验签后走只读查询分发，返回 truth 或 derived 结果 | 未知 query type 显式报错；derived 滞后只能 fail-closed |
| `FLOW-FED-INBOUND-TXN` | inbound transaction | `32` | remote server, `gateway-worker`, `RoomDO`, `UserDO` | `PUT /send/{txnId}` | 验签、去重、分发并返回结果 | 重复事务幂等；部分 PDU 错误单独记录 |
| `FLOW-FED-OUTBOUND-TXN` | outbound transaction | `32` | `RemoteServerDO`, remote server | local event or EDU egress | 排序、打包、发送、确认 | 失败保持同一 `txn_id` 重试 |
| `FLOW-FED-STATE-RETRIEVAL-SERVE` | federation state and event retrieval serve | `32`,`31` | remote server, `gateway-worker`, `RoomDO`, optional R2 | inbound `event`, `event_auth`, `state`, `state_ids`, `backfill`, `get_missing_events`, or `timestamp_to_event` request | 读取房间 truth / archive 指针并返回协议允许结果 | 可见性不满足、归档缺段或事件不存在时 fail-closed，不得虚构 repair backlog 结果 |
| `FLOW-FED-MISSING-EVENT-RECOVERY` | gap repair | `32` | `RemoteServerDO`, `RoomDO`, remote server | 缺 `prev_events` / state gap | 拉取缺失事件并重新准入 | 达到上限进入 dead-letter / repair queue |
| `FLOW-FED-JOIN-LEAVE` | make/send join or leave | `32` | `gateway-worker`, `RoomDO`, `RemoteServerDO`, remote server | federation membership | 模板、签名、提交、状态同步 | 任一步失败都不得污染本地房间真相 |
| `FLOW-FED-USER-KEYS` | federation user devices and key exchange | `32`,`30` | remote server, `gateway-worker`, `UserDO`, optional `RemoteServerDO` | `/user/devices`, `/user/keys/query`, `/user/keys/claim`, or outbound `m.device_list_update` continuity | 验签后按本地用户真相返回 device snapshot / identity keys，或原子 claim one-time keys；设备列表变化继续通过联邦 EDU 增量传播 | 非本地域用户、验签失败或 claim 冲突必须 fail-closed；重复 claim 不得双花 one-time keys |
| `FLOW-FED-MEDIA-SERVE` | federation media serve | `32`,`33` | remote server, `gateway-worker`, R2 | remote server requests media download or thumbnail | 返回本地或已缓存媒体对象，不得依赖外部抓取完成当前请求 | 对象缺失、鉴权不满足或缩略图不可用时返回协议允许错误，不得伪造本地存在性 |
| `FLOW-FED-DISABLED-ROUTE` | explicit disabled/unsupported federation route | `12`,`23`,`32` | remote caller, `gateway-worker` | unsupported federation public route | 返回固定 unsupported response，且不得产生任何 authority or side-effect write | 认证漂移、局部调用下游 handler 或出现副作用都必须视为失败 |

### 2.4 媒体与派生域

| FLOW ID | Name | Owning Spec | Participants | Trigger | Success Path | Failure / Retry Path |
| --- | --- | --- | --- | --- | --- | --- |
| `FLOW-CS-MEDIA-UPLOAD` | media upload | `33` | client, `gateway-worker`, `UserDO`, R2, D1 | upload request | 鉴权、配额、流式写 R2、写目录投影 | 失败回滚 pending upload binding |
| `FLOW-CS-MEDIA-DOWNLOAD` | local media download | `33` | client, `gateway-worker`, R2 | media GET | 按 route family 执行 current authenticated read 或 deprecated compatibility legacy-freeze 裁决，查最小元数据并流式返回 | 对象缺失、鉴权不满足或 legacy freeze 裁决不满足时返回协议错误并记审计 |
| `FLOW-CS-REMOTE-MEDIA-FETCH` | remote media cache | `33` | client, `gateway-worker`, remote server, R2 | current authenticated route cache miss，或 compatibility route 上允许抓取的 miss | 仅在请求路径允许远端抓取时拉取远端、写 R2、返回客户端 | deprecated unauthenticated compatibility route 在 freeze 之后对 cache miss 必须直接 `404 M_NOT_FOUND`，且不得触发新的远端抓取；其他路径仍受并发上限和尺寸限制保护 |
| `FLOW-SEARCH-INDEX` | search/index update | `34` | `gateway-worker`, `RoomDO`, `UserDO`, `jobs-worker`, D1 | truth commit success or explicit derived-work enqueue | 按幂等键更新 D1 | 失败进入重建队列 |
| `FLOW-AS-TXN-DELIVERY` | appservice delivery | `34` | `jobs-worker`, appservice, D1 control plane | truth commit success | 顺序投递 AS transaction | 失败重试且不影响主业务提交 |
| `FLOW-OPS-JOB-CONTROL` | control-plane job control | `42`,`40` | operator, Cloudflare Access, `ops-worker`, `jobs-worker`, D1, R2, optional DOs | Access-protected `/_ops` request | 认证、scope 裁决、审计先落盘；若为 full export，必须先冻结 `DATA-OPS-010` 为 `DATA-OPS-011` 再 fanout shard 作业；随后创建/查询/取消作业 | duplicate idempotency key 折叠或冲突拒绝；manifest/hash/authz 失败必须 fail-closed |
| `FLOW-REPLAY-REBUILD` | replay/reindex | `42`,`34` | `ops-worker`, `jobs-worker`, DOs, D1, R2 | operator action | 从真相与归档重放衍生面 | 断点续跑并保留 manifest |
| `FLOW-OPS-ROLLOUT-SKEW` | pre-release rollout skew probe | `42`,`43`,`44` | GitHub Actions, Cloudflare versions/deployments, `ops-worker`, `gateway-worker`, `UserDO`, `RoomDO` | `TEST-OPS-001` pre-release gate | capture current baseline deployment, upload a candidate gateway version without DO migration, create a dual-version deployment with non-zero share for both versions, pass the workflow-resolved dual-version deployment ID into `IF-OPS-009`, do bounded sampling of probe-owned authorities under explicit baseline/candidate targeting until both baseline-assigned and candidate-assigned `UserDO` / `RoomDO` identities exist, observe `new Worker -> old DO` and `old Worker -> new DO`, then restore the baseline deployment | any upload/deploy/targeting/probe/restore failure must fail-closed; no report may claim rollout-skew coverage without both observed pair classes, the sampled authority identities that enabled them, and a recorded restore attempt |
| `FLOW-OPS-COST-OBSERVATION` | pre-release cost observation | `41`,`43`,`44` | GitHub Actions, optional `ops-worker`, official Cloudflare metrics/billing surfaces | `TEST-COST-001` pre-release gate | execute a bounded workload against the pre-release environment, query official Cloudflare metrics/billing surfaces for the same environment and workload window, normalize `cost_surfaces`, compare them against the model, and attach the resulting observation to the attested pre-release report | missing official metrics permission, incomplete surface coverage, window mismatch, or unresolved pricing semantics must fail-closed; production monthly snapshot remains a separate requirement under `OQ-0002` |

## 3. 状态机目录

| STATE ID | Name | Owning Spec | Entity | Core States | Recovery Focus |
| --- | --- | --- | --- | --- | --- |
| `STATE-USER-SESSION` | session lifecycle | `30` | access/refresh session | created, active, rotated, revoked, expired | token rotation and logout consistency |
| `STATE-UIA-SESSION` | UIA challenge lifecycle | `30`,`40` | route-bound challenge token | issued, challenged, partially-completed, satisfied, expired, rejected | challenge replay, route binding, and stage completion safety |
| `STATE-DEVICE-LIFECYCLE` | device lifecycle | `30` | device | provisioned, active, soft-deleted, hard-deleted | device key invalidation |
| `STATE-SYNC-WAITER` | sync waiter | `30` | worker-held long poll | opened, waiting, woken, assembling, returned, aborted | wake channel loss and deploy interruption |
| `STATE-ROOM-EVENT-ADMISSION` | room event admission | `31` | event | received, validated, waiting-missing, auth-checked, committed, rejected, soft-failed | missing event repair and deterministic rejection |
| `STATE-ROOM-FANOUT-DELIVERY` | room-to-user fanout delivery | `31` | room fanout item | pending, delivering, acked, retrying, repaired, dead-letter | durable outbox drain and `/sync` visibility correctness |
| `STATE-ROOM-MEMBERSHIP` | membership | `31` | room/user membership | leave, invite, join, knock, ban, forgotten | edge-case transitions and visibility |
| `STATE-REMOTE-SERVER-RETRY` | outbound retry | `32` | remote txn | queued, sending, backoff, ready, dead-letter, drained | retry schedule stability |
| `STATE-MEDIA-CACHE-OBJECT` | remote media cache object | `33` | cached media | miss, fetching, present, stale, purging, deleted | partial fetch cleanup |
| `STATE-APPSERVICE-TXN` | appservice txn | `34` | appservice delivery | queued, sending, acked, retrying, poison | exactly-once illusion via idempotency |
| `STATE-REBUILD-JOB` | rebuild job | `42`,`34` | replay/reindex job | pending, scanning, applying, checkpointed, cancel_requested, completed, failed, canceled | resumability |
| `STATE-EXPORT-JOB` | export job | `42` | export bundle | pending, checkpointed, materializing, uploading, cancel_requested, finalized, failed, canceled | partial export cleanup |
| `STATE-RESTORE-JOB` | restore job | `42` | restore/import job | pending, validating, importing, cutover-ready, cutover, cancel_requested, completed, failed, canceled | manifest validation and cutover safety |
| `STATE-REPAIR-JOB` | repair job | `42` | scoped repair job | pending, scanning, applying, verifying, cancel_requested, completed, failed, canceled | bounded blast radius and re-verification |
| `STATE-ROLLOUT-SKEW-PROBE` | rollout skew probe lifecycle | `42`,`43` | pre-release rollout probe run | baseline_captured, candidate_uploaded, dual_version_active, baseline_seeded, candidate_seeded, paired, restore_requested, restored, failed | restore guarantee and pair completeness |
| `STATE-COST-OBSERVATION` | pre-release cost observation lifecycle | `41`,`43` | pre-release cost observation | workload_executed, metrics_queried, normalized, compared, attached, failed | permission gaps, partial metrics, and pricing ambiguity |

## 4. 图示规范

* 每个时序图必须标明参与者、authority handoff、失败分支、重试边界、幂等键。
* 每个状态机必须标明状态、触发器、守卫条件、持久化副作用、超时与恢复动作。
* 图示编号必须稳定，可被接口契约、数据契约、测试计划直接引用。

## 5. 审查规则

* 若某行为存在并发、重试、恢复、版本偏斜或缓存语义，则必须有图。
* 若某对象具有生命周期、重试或多阶段处理，则必须有状态机。
* 任一 `IF-ID` 若跨越信任边界或 authority handoff，必须至少挂一个 `FLOW-*` canonical ID。

## 6. 完成标准

* 所有关键路径均已列入目录；
* 每个复杂行为都知道必须产出哪张图；
* 流程图和状态机可直接服务于实现与测试。
