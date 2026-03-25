# Room Processing and Room Versions Spec

状态：Draft-Normative
角色：房间核心分册  
负责主文档章节：4  
继承的单体章节：14，9.2

## 1. 文档职责

* 定义房间核心处理责任。
* 定义事件接纳流水线、授权检查、状态解析与持久化边界。
* 定义房间版本抽象层与版本兼容策略。
* 定义 `RoomDO` 与本地 fanout 的职责边界。

明确不包含：

* 不定义客户端同步正文；
* 不定义联邦外发重试正文；
* 不定义搜索与目录正文。

## 2. `RoomDO` 责任模型

`RoomDO(room_id)` 必须承担以下唯一主责：

* 事件 DAG 权威持久化
* state resolution 与 auth 裁决
* membership 当前视图
* room timeline 单调位置 `room_pos`
* current state 快照
* receipts / typing 当前值
* 本地用户 fanout 元信息生成
* 向 `RemoteServerDO` 提供联邦出站源数据

`RoomDO` 不负责：

* 长轮询持有
* 用户 session / device 真相
* D1 搜索和目录写入

## 3. 统一事件接纳流水线

### 3.1 统一入口要求

无论事件来自：

* 本地客户端
* Application Service
* 联邦入站

都必须进入同一 `IF-INT-ROOM-001 admitEvent()` 管道。引用：`FLOW-ROOM-EVENT-ADMISSION`。

### 3.2 Admission Pipeline

事件接纳必须按以下顺序执行：

1. 基础形状与 room version 前置校验。
2. canonical JSON、event id、hash 与签名校验。
3. `prev_events` / `auth_events` 充分性检查。
4. 计算 `state_before_event`。
5. 执行 room-version-specific `authCheck()`。
6. 应用 redaction、relation 与 membership 规则。
7. 为通过事件分配新的 `room_pos`。
8. 写入 `DATA-ROOM-001`、`DATA-ROOM-002`、`DATA-ROOM-003`、`DATA-ROOM-004`、`DATA-ROOM-005`、`DATA-ROOM-006`、`DATA-ROOM-007`、`DATA-ROOM-008`、`DATA-ROOM-009`、`DATA-ROOM-010`，并在适用时更新 `DATA-ROOM-011` 与 `DATA-ROOM-012`。
9. 生成本地 fanout 与联邦出站意图。

### 3.3 失败语义

* 校验失败必须原子拒绝，不得留下部分 state。
* 对联邦事件，若缺少必要 `prev_events`/`auth_events` 且策略允许等待恢复，则事件进入 `waiting-missing` 状态机分支。引用：`STATE-ROOM-EVENT-ADMISSION`。
* soft-failed 事件必须持久化其状态，使其仍可参与后续 state resolution，但不得直接 fanout 给客户端。

## 4. Auth 与授权钩子

### 4.1 规范性要求

* 所有房间授权判断都必须通过 `RoomVersionStrategy.authCheck()`。
* `m.room.member`、`m.room.power_levels`、`m.room.join_rules`、`m.room.redaction` 等关键事件不得在业务层硬编码散点分支。

### 4.2 Membership 事件

membership 变更规则：

* 邀请、加入、离开、封禁、解封、踢出、敲门都必须表现为 membership event，而不是外部 side-effect。
* 本地用户 `displayname` / `avatar_url` 更新后的 profile refresh 也必须表现为新的 `m.room.member` `join` 事件，不得就地篡改旧 membership 记录。
* 任何 membership 变更成功后，`DATA-ROOM-007` 当前视图必须与提交事件原子同步。
* 批量 profile propagation 可以异步分片，但每个房间的 refresh 都必须重新进入同一准入流水线，并对 `{user_id,profile_version,room_id}` 幂等。

### 4.3 Redaction

* redaction 事件的可发送性与实际 redaction 的适用性必须分开判断。
* 实际 redaction 应用条件由房间版本策略和事件 sender 权限共同裁决。
* redacted 事件对客户端的表现必须遵循对应 room version 的 redaction 算法。

## 5. State Resolution 策略

### 5.1 策略抽象

`RoomDO` 必须通过 `RoomVersionStrategy` 暴露以下最小接口：

* `validateEventShape`
* `validateEventIdAndHash`
* `authCheck`
* `redactEvent`
* `resolveState`
* `supportsRestrictedJoin`
* `supportsKnock`
* `createRoomIdIfNeeded`

### 5.2 快照缓存

* 已解析过的 extremity set 必须按稳定哈希缓存为 `DATA-ROOM-005`。
* 当前状态不是事件表的派生即时查询，而是提交时同步维护的当前 snapshot。

### 5.3 计算预算

* 对大房间或长 auth chain，state resolution 必须设置明确 CPU 预算。
* 对本地客户端与 Application Service 发起的写入，`admitEvent()` 必须在单次调用内同步完成 resolution 并给出终态；若超出预算，必须 deterministic 拒绝，不得进入未定义的 pending admission。
* 只有联邦缺事件恢复路径才允许通过 `waiting-missing` 分支延后重新准入；该分支必须以缺失上下文为前提，而不是把“预算不够”当作等待理由。

## 6. 房间版本策略

### 6.1 基线支持

* 新建房间默认 room version 为 `12`。
* 面向联邦 GA 前，必须稳定支持 room version `11` 与 `12`。
* `createRoom` 必须允许显式请求 `11`；当请求未显式指定版本时，项目策略默认选 `12`，这是本实现决策，而不是对 Matrix 推荐默认值的转述。

### 6.2 版本差异封装

room version `11` 的以下差异必须封装在策略层：

* redaction 保留字段集合与旧版本不同：顶层 `origin`、`membership`、`prev_state` 不再受保护。
* `m.room.create` 被 redaction 后必须保留完整 `content`。
* `m.room.redaction` 被 redaction 后必须保留 `content.redacts`。
* `m.room.power_levels` 被 redaction 后必须保留 `content.invite`。
* `m.room.member` 的 `third_party_invite` 在 redaction 后只允许保留其 `signed` 子键。
* `m.room.redaction` 的可发送性按普通事件 auth rules 裁决，不再把 redact level 直接塞进 auth rule 快捷分支。

room version `12` 的以下差异必须封装在策略层：

* 房间 ID 必须是 `m.room.create` 事件 ID 把 sigil 从 `$` 替换为 `!` 后得到；创建事件自身不得携带 `room_id`。
* `m.room.create` 的 `content.additional_creators` 若存在，必须是合法 user ID 字符串数组。
* room creators 的 power level 必须视为“无限高”，不能被后续 `m.room.power_levels` 降权。
* auth events selection 中不得把 `m.room.create` 选入 `auth_events`；其存在由 `room_id` 隐含。
* 若事件的 `room_id` 不能对应到已接受的 `m.room.create` 事件 ID，则必须拒绝。

两种版本共同要求：

* 事件 ID 继续使用基于引用哈希的 URL-safe base64 形态。
* state resolution 继续使用 room state resolution v2；任何差异都只能体现在策略层的输入校验、auth selection 与 redaction 规则上。
* `RoomDO` 业务代码中禁止散落 `if (roomVersion === ...)` 分支。

### 6.3 老版本与未来版本

* 旧稳定版本可在 profile 中按条件支持，但必须通过独立 strategy 实现。
* 新版本引入时，只允许新增 strategy，不允许修改既有版本行为。

## 7. 存储布局与冷热分层

### 7.1 热层

热层必须保留：

* 当前 snapshot
* forward extremities
* 最近事件 JSON
* membership 当前视图
* receipts / typing 当前值

### 7.2 温层

温层保留：

* 历史事件元数据
* snapshot 链
* soft-failed / waiting-missing 事件

### 7.3 冷层

冷层转入 R2：

* 老事件 canonical JSON
* 老 snapshot materialization
* 审计与恢复片段

热层在冷化后仍必须保留：

* `event_id -> archive segment` 索引
* timeline 分页所需最小元数据
* state rebuild 所需最小指针

## 8. 本地 Fanout 与用户流交接

### 8.1 RoomDO 输出不是 `/sync`

`RoomDO` 提交后只生成“用户可见 delta”，不得自行拼装 `/sync`：

* 受影响本地用户
* 每用户受影响房间与 `room_pos` 范围
* membership 变化
* 是否需要 unread / notification 重算
* 是否产生 device list 变化

### 8.2 Fanout 交接

* `RoomDO -> UserDO` 必须使用 `IF-INT-USER-003 appendRoomFanout(delta)`。
* fanout 交接幂等键必须至少包含 `{room_id,room_pos,user_id}`。
* `RoomDO` 在提交事件成功后，必须先把每个本地用户目标写入 `DATA-ROOM-011` durable outbox，再发起 `appendRoomFanout(delta)`。
* `appendRoomFanout(delta)` 返回的 ack 必须表示对应 delta 已被 `UserDO` durable append 到 `DATA-USER-010`；只有收到 durable ack 后，`RoomDO` 才可回收该 outbox item。
* `UserDO` 仅在成功写入用户流后才认为该用户已看见此房间变化。
* 对单用户 fanout 失败，`RoomDO` 必须保留 outbox item 并按 at-least-once 语义重试；`UserDO` 必须按 `{room_id,room_pos,user_id}` 幂等吸收重复交付。
* repair/rebuild 流程必须能够基于 `DATA-ROOM-011` 与 `DATA-USER-010` 重新核对并补齐缺失 fanout，确保 `/sync` token 语义不依赖易失内存。

### 8.3 Fanout Reconcile / Repair 规则

以 `FLOW-ROOM-FANOUT-REPAIR` 为准，fanout 修复裁决必须固定如下：

* 若 `DATA-ROOM-011` 存在 pending item，且 `UserDO` 侧找不到对应 `{room_id,room_pos,user_id}` durable append，则必须重驱 `appendRoomFanout(delta)`，不得直接 GC。
* 若 `DATA-ROOM-011` 仍为 pending，但 `UserDO` 已存在对应 durable append，则必须把该 outbox item 标记为 `acked` 并 GC，而不是再次投递。
* 若房间事件 truth 已提交、目标用户仍属本地且应观察该房间变化，但 `DATA-ROOM-011` 与 `DATA-USER-010` 同时缺记录，则 repair 流程必须按房间 truth 重新生成 outbox item，并把该动作写入 `DATA-OPS-003/004`。
* 任一 reconcile 都不得直接改写 `next_batch`；`/sync` 可见性只能通过重新建立或确认 durable fanout 达成。

## 9. Ephemeral 房间状态

* typing 当前视图由 `DATA-ROOM-010` 持有，并由 `IF-ALARM-002` 过期。
* receipts 当前视图由 `DATA-ROOM-009` 持有，只保留每个 receipt key 的最新值。
* unread / notification 计数不是 `RoomDO` 真相表；`RoomDO` 只输出“是否需要按当前 push-rules snapshot 重算”的信号。
* ephemeral 写入失败不得影响 timeline 或 current state 提交。

## 10. 房间查询面

### 10.1 统一只读查询族

下列 client query surfaces 必须统一归入同一个 `RoomDO` 只读裁决面，而不是散落到独立副本或缓存逻辑：

* `/messages`
* `/context/{eventId}`
* `/event/{eventId}`
* `/state` 与 `/state/{eventType}/{stateKey}`
* `/members` 与 `/joined_members`
* `/relations/{eventId}` 家族
* `/threads`
* `/timestamp_to_event`

这些查询都必须共享同一套房间可见性、redaction 后视图与 membership 边界判断；任何查询面都不得绕过 `RoomDO` 直接从 D1、KV 或 R2 给出权威答案。

### 10.2 关系、线程与时间定位

* `RoomDO` 必须按 [24-data-contract-catalog.md](/root/Matrix/spec/framework/24-data-contract-catalog.md) 中 `DATA-ROOM-001` 最小形态维护显式 query metadata，使 `/relations`、`/threads` 与 `/timestamp_to_event` 能在热路径上完成查询，而不是为每次请求重扫冷归档。
* `/relations` 与 `/threads` 的结果必须基于房间权威事件图和 relation metadata 计算，并应用与普通 timeline 相同的可见性与 redaction 规则。
* `/timestamp_to_event` 必须按规范给出“相对目标 timestamp 与方向约束下的最近可见事件”；若不存在满足条件的可见事件，必须返回该 endpoint 允许的 no-result 语义，而不是猜测最近 `room_pos`。
* `RoomDO` 对 `/messages`、`/context`、`/event`、`/state`、`/members`、`/joined_members`、`/relations`、`/threads`、`/timestamp_to_event` 的内部实现，不得拆成多个语义漂移的私有接口；所有 query kind 都必须统一经 `IF-INT-ROOM-003 queryRoom(readRequest)` 进入单一只读裁决面。

### 10.3 冷归档读取规则

* R2 冷归档只允许在 `RoomDO` 完成 event existence、membership boundary、history visibility 与 redaction 裁决之后，作为 canonical JSON 或 snapshot materialization 的字节来源。
* 任一 cold-hit 读取都必须先通过 `DATA-ROOM-001` 中的精确 archive 指针定位到 `DATA-R2-004`；禁止在热路径中执行 R2 list、全段扫描或“遍历最近几个 segment 试试看”。
* `/context` 必须先用权威 timeline 元数据确定 before/after 的 `room_pos` 窗口，再按需回填冷段 JSON；不得把冷段顺序直接当作 timeline 主排序。
* `/event`、`/relations`、`/threads` 命中冷事件时，必须仍以 `DATA-ROOM-001` 中的 metadata 为主裁决可见性，R2 只提供 event body，不得反向覆盖权威 metadata。
* 若冷归档对象缺失、hash 校验失败、或 metadata 指针无法定位到唯一对象，则该请求必须返回 typed integrity failure 并触发 repair signal；不得静默降级为“事件不存在”。

## 11. Membership 边界条件

规范性 membership 状态机引用：`STATE-ROOM-MEMBERSHIP`。

必须直接编码的边界条件包括：

* `invite -> join`
* `invite -> leave`
* `knock -> invite`
* `knock -> leave`
* `ban -> unban -> leave`
* `leave -> forget`
* `leave/invite/knock` 在 `/sync` 可见性上的差异

forget 只影响客户端可见性，不删除房间真相。

## 12. 房间域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| create/join/leave/invite/ban/knock | `IF-CS-030`,`IF-CS-031` | `IF-INT-ROOM-001` | `DATA-ROOM-001`,`DATA-ROOM-007` |
| send state / message | `IF-CS-032`,`IF-CS-033` | `IF-INT-ROOM-001` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` |
| paginate / context / event / state / members / relations / threads / timestamp lookup | `IF-CS-034` | `IF-INT-ROOM-003` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-R2-004` |
| room sync projection | via `IF-CS-020` | `IF-INT-ROOM-002` | `DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` |

## 13. 完成标准

* 房间事件真相路径唯一；
* 房间版本适配边界可编码；
* 本地与远端输入的处理规则统一；
* 房间域已接入接口、数据、流程目录；
* 实现团队可直接据此拆解 `RoomDO` 与房间域模块。
