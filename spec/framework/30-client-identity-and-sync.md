# Client Identity, E2EE Transport, and Sync Spec

状态：Draft-Normative
角色：客户端责任域分册  
负责主文档章节：4  
继承的单体章节：13，9.1，9.3，9.4

## 1. 文档职责

* 定义用户、设备、会话、账号数据、to-device、presence 的责任边界。
* 定义客户端侧 E2EE 传输相关行为边界。
* 定义 `/sync` 模型、令牌、长轮询、唤醒与增量流。
* 定义客户端域与 `UserDO`、`gateway-worker` 的交互分工。

明确不包含：

* 不定义房间 auth/state resolution 正文；
* 不定义联邦正文；
* 不定义媒体正文。

## 2. 责任边界

### 2.1 `UserDO` 是客户端域权威

`UserDO(user_id)` 必须拥有以下真相：

* access token / refresh token 生命周期
* device 清单与设备元数据
* device keys、cross-signing、one-time/fallback keys
* profile document
* global / room account data
* stored filter definitions
* push rules overrides / enablement
* to-device 队列
* presence 当前值
* `user_stream` 及其 `user_stream_pos`

### 2.2 `gateway-worker` 是客户端域接入层

`gateway-worker` 必须负责：

* 公开 Client-Server API 路由
* access token 解析与 `UserDO` 定位
* `/sync` 长轮询持有
* 响应聚合与流式输出
* 将房间写路径转交 `RoomDO`

`gateway-worker` 不得拥有任何客户端真相。

## 3. 用户、设备与会话模型

### 3.1 用户模型

* 用户身份以 Matrix `user_id` 为唯一主键。
* 所有认证成功最终都必须归一到 “生成或恢复一个 `UserDO` 作用域内的 session”。
* 用户注销、停用、会话吊销都必须从 `UserDO` 真相出发，而不是依赖缓存层。

### 3.2 设备模型

* 设备是 `user_id` 下的稳定命名实体，由 `device_id` 标识。
* 设备是以下数据的关联点：
  * access session
  * refresh session
  * device keys
  * one-time / fallback keys
  * to-device 投递目标
* 设备删除必须原子地使其 access session 和设备 key 失效。

### 3.3 会话模型

规范性 session 状态机引用：`STATE-USER-SESSION`。

会话实现必须满足：

* access token 仅以 hash 形式存储。引用：`DATA-ID-003`。
* refresh token 仅以 hash 形式存储。引用：`DATA-ID-004`。
* `logout` 撤销当前 session；`logout/all` 撤销用户全部活动 session。
* 推荐在 `UserDO` 内维护 `session_epoch`；`logout/all` 通过 epoch 跳变实现 O(1) 失效判定，然后异步清扫旧 session 记录。

### 3.4 鉴权基线

* 所有 access token 校验必须走 `IF-INT-USER-001`。
* session 校验结果必须至少返回：
  * `user_id`
  * `device_id`
  * `session_id`
  * `expires_at`
  * `is_guest`
  * `session_epoch`
* 任何鉴权失败都不得进入 `RoomDO` 或后续业务路径。

## 4. 注册、登录、刷新与注销规则

### 4.1 注册

* 所有注册流程都必须收敛到 `UserDO` 创建用户主记录、初始 device 和初始 session。
* 若注册需要 UIA、registration token 或其他前置校验，`gateway-worker` 只负责协议编排，最终提交仍由 `UserDO` 原子完成。
* 同一注册请求的重试不得造成重复用户创建。

### 4.2 登录

* 登录成功必须创建或恢复一个 device 关联的活动 session。
* `login` 响应中的 access token 和 refresh token 必须绑定到同一 `session_id`。
* 登录失败不得产生任何残留 session、device 或用户流副作用。

### 4.3 刷新

* `refresh` 必须通过 `IF-CS-012` 与 `IF-INT-USER-001`/`IF-INT-USER-002` 相同的 `UserDO` 权威路径完成。
* refresh 成功后，旧 refresh token 必须失效，access token 应同时轮换。
* refresh token 重放必须返回明确失败，而不是返回新的可用 token。

### 4.4 注销

* `logout` 只撤销当前 session。
* `logout/all` 撤销全部 session，并强制后续 access token 失效。
* 注销不删除 device；设备删除是单独操作。

## 5. 能力声明、Profile、账号数据、Push Rules、To-Device 与 Presence

### 5.1 Capabilities and Filters

* `GET /_matrix/client/*/capabilities` 的结果来自部署时配置与运行时策略，但其返回值必须与真实可写权限一致。
* `m.profile_fields` 必须返回规范要求的 `enabled`，并按实际策略返回可选的 `allowed` / `disallowed` 列表。
* 若 `m.profile_fields` 直接或间接禁止修改 `displayname` 或 `avatar_url`，则已废弃的 `m.set_displayname` / `m.set_avatar_url` 也必须同步返回 `enabled: false`。
* `m.profile_fields`、`m.set_avatar_url`、`m.set_displayname`、room versions 等 capability 不得“宣称支持但写路径拒绝”。
* stored filters 的权威表是 `DATA-USER-014`。
* filter 创建时必须对 JSON 做 canonicalization，再生成稳定 hash 和 `filter_id`；`filter_id` 不得以 `{` 开头。
* `GET /_matrix/client/*/sync` 的 `filter` 查询参数必须按首字符解释：若首字符是 `{`，则视为 inline JSON filter string；否则视为此前创建的 stored `filter_id`。
* `/sync` 对 stored filter 和 inline filter 的解释都必须确定；相同 `{since,filter}` 不得因部署节点不同而产生语义分叉。

### 5.2 Profile Truth and Propagation

* profile truth 的权威表是 `DATA-USER-012`，独立于 account data。
* `v1.17` 基线下，必须支持 `displayname`、`avatar_url`、`m.tz` 以及 policy 允许的 namespaced custom fields。
* `PUT /_matrix/client/*/profile/{userId}/{keyName}` 的请求体必须是“恰好一个属性”的 JSON object，且该属性名必须与 URL 中的 `keyName` 完全一致。
* `keyName` 只允许 `displayname`、`avatar_url`、`m.tz` 或满足 namespaced grammar 的自定义字段；`displayname` 必须是 string，`avatar_url` 必须是 MXC URI，`m.tz` 必须是 IANA 时区标识。
* 服务端可以拒绝 `null` 值；若接受 `null`，则必须按 `null` 存储，而不是把它解释成删除。删除字段只能走 `DELETE /_matrix/client/*/profile/{userId}/{keyName}`。
* 更新后的 total profile document 必须小于 `64 KiB`；超限时必须按协议返回 `M_PROFILE_TOO_LARGE`。
* successful profile write 必须先原子更新 `DATA-USER-012`，再启动传播路径。
* 每次成功的 profile truth 变更都必须在同一事务里生成新的、单调递增的 `profile_version`；该版本号是 profile propagation、重放与去重的唯一排序键。
* `displayname` 或 `avatar_url` 变更时，homeserver 必须自动产生两类传播：
  * 带新 profile 值的 presence 增量；
  * 对该用户当前已加入的每个本地房间生成新的 `m.room.member` `join` refresh 事件。
* 传播可以异步分片执行以适应 Cloudflare 限制，但必须按 `{user_id,profile_version,room_id}` 幂等，并且不得丢失较新的 profile 版本。
* public profile read 与 federation profile query 都必须应用 Matrix 可见性规则；无权读取时只能返回协议允许的 `403/404`，不得泄漏字段存在性。

### 5.3 Account Data

* global account data 的权威表是 `DATA-USER-006`。
* room account data 的权威表是 `DATA-USER-007`，即使其语义关联房间，也不属于 `RoomDO`。
* `m.direct`、ignored users、tags、`m.marked_unread` 等都属于 account data / read-marker 家族，不属于 profile truth。
* account data 变更必须进入 `user_stream`，供 `/sync` 发出增量。

### 5.4 Push Rules and Notification State

* custom push rules、enabled 状态和规则顺序的权威表是 `DATA-USER-013`。
* Matrix `v1.17` 默认 push rules 必须由服务端按规范基线合成；用户存储只保存覆盖、禁用和顺序调整。
* 必须支持 `GET /pushrules/`、`GET /pushrules/global/`、`GET/PUT/DELETE /pushrules/global/{kind}/{ruleId}`、`GET/PUT /.../{ruleId}/actions`、`GET/PUT /.../{ruleId}/enabled` 这些 `v1.17` 路由面。
* `kind` 只允许 `override`、`underride`、`sender`、`room`、`content`；用户自定义 `ruleId` 不得以 `.` 开头，且不得包含 `/` 或 `\\`。
* `PUT /pushrules/global/{kind}/{ruleId}` 创建规则时，若没有 `before` / `after`，新规则必须成为同类用户自定义规则中最高优先级；若同时给出 `before` 和 `after`，必须以 `before` 为主确定新顺序。
* 新创建的 push rule 必须默认 `enabled = true`。
* `/actions` 与 `/enabled` 子资源只允许修改对应字段，不得隐式重写条件、pattern 或顺序。
* push rule 写入必须由 `UserDO` 线性化，并在后续 `/sync` 中生效。
* 为控制 Cloudflare CPU 和滥用面，单用户自定义 push rules 默认上限为 `256` 条；单条规则最多 `32` 个 conditions；用户 overrides 的总 canonical JSON 体积默认上限为 `64 KiB`。
* unread counters、notification counts 和 `unread_thread_notifications` 必须由 `RoomDO` delta 与当前 push-rules snapshot 共同计算，再进入 `user_stream`。
* private / threaded receipts 与 read markers 是计数输入；但 receipt 当前视图仍由 `RoomDO` 权威持有。
* 计数更新失败不得改写房间 timeline truth，但必须可由房间真相和 push-rules snapshot 重算修复。

### 5.5 To-Device

* to-device 消息权威表是 `DATA-USER-008`。
* to-device 投递顺序以目标设备视角按照 `user_stream_pos` 递增。
* 当客户端发起新的 `/sync?since=X` 时，`UserDO` 才可以认定该 session 已经观察到 `X` 之前的用户流，从而清理对该 session 已确认的 to-device 记录。
* 对长期离线 session，允许按保留策略进行 TTL 清理，但必须记录为协议可见的丢弃策略，不得静默假定已送达。

### 5.6 Presence

* presence 当前值由 `DATA-USER-009` 持有。
* presence 更新必须线性化进入 `user_stream`，避免 `/sync` 与 `/presence` 读面不一致。
* profile `displayname` / `avatar_url` 变更触发的自动 presence refresh 也必须走同一线性化路径。
* presence 传播是最终一致 fanout，但本用户的当前值读取必须强一致。

## 6. E2EE 传输边界

### 6.1 本分册负责的内容

本分册只负责 E2EE 传输与存储边界，不负责解密语义：

* device keys 上传与查询
* one-time / fallback keys claim
* cross-signing key material的上传与读取
* room key backup 元数据与密文备份对象
* to-device 加密负载投递
* `/sync` 中 `device_lists`、`device_one_time_keys_count`、`device_unused_fallback_key_types`

### 6.2 明确不负责的内容

* 不在服务端执行 Megolm/Olm payload 解密；
* 不在服务端解释房间密钥业务内容；
* 不把服务端 key backup 设计成客户端明文密钥托管。

### 6.3 关键规则

* `/keys/claim` 必须保证 one-time key 至多返回一次。引用：`REQ-ARCH-011`,`DATA-USER-004`。
* fallback key 可以重复返回直至被替换或按协议标记失效，但它的使用状态必须进入 `/sync`。
* 任何设备 key 或 cross-signing 变更都必须生成 `device_lists` 增量。
* room key backup 的版本元数据由 `DATA-USER-011` 持有；大体量密文分片可写入 `DATA-R2-006`，服务端只保证完整性和版本隔离，不解释密钥明文。

## 7. `/sync` 目标与令牌模型

### 7.1 设计目标

`/sync` 是设备视角增量流接口，不是普通查询接口。必须满足：

* 单调前进的 `next_batch`
* 对空闲客户端的 long-poll 行为
* 聚合用户域、房间域、to-device、presence、E2EE 元数据
* 成本在 Cloudflare 上可控

### 7.2 Token 规则

`next_batch` 对客户端必须完全 opaque。规范性规则如下：

* token 至少包含版本前缀与 `user_stream_pos`。引用：`DATA-ID-001`。
* token 不得要求服务端保留 mutable waiter state 才能解析。
* token 可选包含 `device_id_hash`、`filter_hash`、`capability_bits` 以做误用检测，但授权仍以 access token 为准。
* 无新数据时允许返回新的 `next_batch` 等于旧 token 对应位置。

### 7.3 用户流模型

`UserDO` 必须维护单调递增的 `user_stream_pos`，以下变化都必须写入 `DATA-USER-010`：

* room delta
* invite / leave / knock delta
* account data 变化
* to-device
* presence
* device lists changed / left
* one-time key count
* fallback key types
* receipt / typing 聚合更新

## 8. Worker-Held Long Poll 设计

### 8.1 规范性结论

* `/sync` 长轮询必须由 `gateway-worker` 持有，不得由 `UserDO` 直接持有 HTTP 请求。引用：`CF-WKR-001`,`CF-DO-009`。
* `UserDO` 只负责用户流推进和唤醒信号，不负责占用公网等待连接。

### 8.2 请求处理流程

1. `gateway-worker` 调用 `IF-INT-USER-001` 解析 access token。
2. 解析 `since` token，并将其作为该 session 的 `last_seen_sync_pos` 候选前移。
3. 调用 `IF-INT-USER-002` 获取当前是否已有用户流增量。
4. 若已有增量，立即投影并响应。
5. 若无增量，创建本地 waiter，并通过唤醒通道等待。
6. 被唤醒后再次执行 `collectSince`。
7. 对涉及房间的 delta 调用 `IF-INT-ROOM-002`。
8. 组合响应并返回新的 `next_batch`。

### 8.3 唤醒通道

首选实现：

* `UserDO` 作为 WebSocket Hibernation server；
* `gateway-worker` 为每个活跃长轮询建立轻量唤醒连接；
* 唤醒消息只携带“用户流至少推进到某位置”的摘要，不携带业务 payload。

降级实现：

* 若 hibernation 通道不稳定，则使用低频自适应轮询 `collectSince`；
* 但“Worker 持有长轮询”的原则不变。

### 8.4 并发与背压

* 同一 `session_id` 同一参数集只允许一个活跃 `/sync` waiter。
* 对并发重复请求，服务端应优先保留最新请求并尽早结束旧请求，避免双倍成本。
* `UserDO` 唤醒消息必须可合并；只要 Worker 知道“位置前进了”，就不需要每条流记录单独唤醒。

## 9. `/sync` 响应组装规则

* `/sync` 响应的房间部分由 `RoomDO.projectForSync()` 提供局部投影，而不是由 `UserDO` 拼接房间详情。
* `use_state_after=true` 时，必须输出 `state_after` 而不是旧式 `state`。
* 若任一房间投影失败，则本次 `/sync` 不得推进 `next_batch`。
* to-device、device lists、one-time key count 和 fallback key types 都必须来自与 `since` 同一用户流快照边界。

## 10. 失败、重试与成本控制

* runtime 更新导致的长轮询中断应当表现为正常早返回，客户端重试即可。引用：`CF-DO-010`。
* wake 通道断开时，Worker 应执行一次最终 `collectSince`，然后返回空或增量响应，不得悬挂。
* 默认长轮询 timeout 建议 `30s`，避免大量长连接无限驻留。
* typing 与 receipts 必须在 `UserDO` 或 `RoomDO` 侧先聚合，再进入用户流。

## 11. 客户端域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| register/login/logout/refresh | `IF-CS-010`-`013` | `IF-INT-USER-001` | `DATA-USER-001` |
| capabilities / filters | `IF-CS-002`-`004` | none | `DATA-USER-014` |
| profile | `IF-CS-017` | none | `DATA-USER-012` |
| device management | `IF-CS-040` | `IF-INT-USER-001` | `DATA-USER-002`,`DATA-USER-003` |
| account data / tags / read-unread markers | `IF-CS-015` | `IF-INT-USER-002` | `DATA-USER-006`,`DATA-USER-007` |
| push rules | `IF-CS-018` | none | `DATA-USER-013` |
| presence | `IF-CS-016` | `IF-INT-USER-002` | `DATA-USER-009`,`DATA-USER-010` |
| to-device | `IF-CS-041` | `IF-INT-USER-003` | `DATA-USER-008`,`DATA-USER-010` |
| keys / cross-signing / backup | `IF-CS-042`-`045` | `IF-INT-USER-004` | `DATA-USER-003`,`004`,`005`,`011`,`DATA-R2-006` |
| `/sync` | `IF-CS-020` | `IF-INT-USER-002`,`IF-INT-ROOM-002` | `DATA-ID-001`,`DATA-USER-010` |

## 12. 完成标准

* 客户端域责任边界闭合；
* `/sync` 模型能直接指导实现；
* E2EE 传输边界与非边界清楚；
* 客户端域已接入接口、数据、流程目录；
* 与房间域和安全域的接口无重叠。
