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
8. 写入 `DATA-ROOM-001` 至 `DATA-ROOM-010`。
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

* 对大房间或长 auth chain，state resolution 必须分阶段执行并设置 CPU 预算。
* 若单次 resolution 超出预算，应保存中间状态或降级为异步补偿，而不是让 `gateway-worker` 长时间阻塞。

## 6. 房间版本策略

### 6.1 基线支持

* 新建房间默认 room version 为 `12`。
* 面向联邦 GA 前，必须稳定支持 room version `11` 与 `12`。

### 6.2 版本差异封装

* room version `11` 的 redaction 规则差异必须封装在策略层。
* room version `12` 的 room ID 生成、creator power level 语义与 state resolution 变化必须封装在策略层。
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
* `UserDO` 仅在成功写入用户流后才认为该用户已看见此房间变化。

## 9. Ephemeral 房间状态

* typing 当前视图由 `DATA-ROOM-010` 持有，并由 `IF-ALARM-002` 过期。
* receipts 当前视图由 `DATA-ROOM-009` 持有，只保留每个 receipt key 的最新值。
* unread / notification 计数不是 `RoomDO` 真相表；`RoomDO` 只输出“是否需要按当前 push-rules snapshot 重算”的信号。
* ephemeral 写入失败不得影响 timeline 或 current state 提交。

## 10. Membership 边界条件

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

## 11. 房间域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| create/join/leave/invite/ban/knock | `IF-CS-030`,`IF-CS-031` | `IF-INT-ROOM-001` | `DATA-ROOM-001`,`007` |
| send state / message | `IF-CS-032`,`IF-CS-033` | `IF-INT-ROOM-001` | `DATA-ROOM-001`-`008` |
| paginate / context / event lookup | `IF-CS-034` | `IF-INT-ROOM-003` | `DATA-ROOM-001`,`002` |
| room sync projection | via `IF-CS-020` | `IF-INT-ROOM-002` | `DATA-ROOM-005`-`010` |

## 12. 完成标准

* 房间事件真相路径唯一；
* 房间版本适配边界可编码；
* 本地与远端输入的处理规则统一；
* 房间域已接入接口、数据、流程目录；
* 实现团队可直接据此拆解 `RoomDO` 与房间域模块。
