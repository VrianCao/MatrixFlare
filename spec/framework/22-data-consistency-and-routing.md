# Data, Consistency, and Routing Spec

状态：Draft-Normative
角色：数据基础分册  
负责主文档章节：3  
继承的单体章节：10-12

## 1. 文档职责

* 定义核心实体目录与数据归属。
* 定义真相面、派生面、缓存面的边界。
* 定义各类数据的一致性语义。
* 定义客户端、联邦、媒体、`/.well-known` 的路由模型。
* 定义数据标识、令牌、幂等键与顺序保证的挂载位置。

明确不包含：

* 不展开客户端接口行为；
* 不展开房间算法正文；
* 不展开联邦交互细节。

## 2. 全局一致性声明

本系统不是全局线性化数据库。它是：

* `per-room` 强串行主权；
* `per-user` 强串行主权；
* `per-remote-server` 强串行出站；
* `global derived views` 最终一致。

因此：

* 真相面由 DO SQLite 持有；
* 衍生面由 D1/R2 manifests/Queues 持有；
* 缓存面由 KV 或内存态持有；
* 不允许任何派生面反向裁决真相。

## 3. 核心实体目录

| Entity | Authority | Primary Store | Secondary Store | Notes |
| --- | --- | --- | --- | --- |
| User | `UserDO` | DO SQLite | D1 user directory projection | 单一 `user_id` 主权。 |
| Device | `UserDO` | DO SQLite | D1 device lookup projection | 设备删除与 key 变更都在 `UserDO`。 |
| Session / Refresh | `UserDO` | DO SQLite | none | 不允许缓存为权威。 |
| User stream | `UserDO` | DO SQLite | none | `/sync` token 基准。 |
| To-device queue | `UserDO` | DO SQLite | none | 仅用户主权对象消费与裁决。 |
| Room | `RoomDO` | DO SQLite | D1 directory projection | 房间元信息与版本在 `RoomDO`。 |
| Event DAG | `RoomDO` | DO SQLite | R2 cold archive | 热元数据留在 DO。 |
| Current state | `RoomDO` | DO SQLite | none | 不落 D1 真相。 |
| Membership projection | `RoomDO` | DO SQLite | D1 derived membership search | 房间权威，用户侧只消费结果。 |
| Remote outbound queue | `RemoteServerDO` | DO SQLite | D1 ops metrics optional | 远端事务与重试主权。 |
| Media object | R2 | R2 | D1 media catalog | R2 为对象真相。 |
| Media metadata | mixed | R2 metadata + D1 projection | KV cache optional | 下载最小元数据不得只在 D1。 |
| Search index | derived | D1 | none | 可完全重建。 |
| Appservice config | control plane | D1 + secrets | KV cache optional | 不属于房间/用户真相。 |

## 4. 标识、令牌与幂等键

| Token / ID | Owner | Opaque to Client | Normative Rule |
| --- | --- | --- | --- |
| `user_id` | Matrix protocol | no | 遵循 Matrix ID 规则；内部禁止再映射为隐藏数字主键。 |
| `room_id` | Matrix protocol | no | 房间唯一主键；路由和分片都以 `room_id` 为准。 |
| `event_id` | Matrix protocol / room version | no | 作为搜索、索引、重放幂等主键。 |
| `device_id` | Matrix protocol | no | 在 `user_id` 范围内唯一。 |
| `next_batch` | `UserDO` | yes | 对客户端完全 opaque；内部至少编码版本与 `user_stream_pos`。 |
| `prev_batch` | `RoomDO` | yes | 房间分页游标必须可独立验证，不依赖 mutable server state。 |
| access token | `UserDO` | yes | 只存 hash，不存明文。 |
| refresh token | `UserDO` | yes | 只存 hash；刷新后按策略轮换。 |
| Queue job id | producer | yes | 必须可从业务幂等键稳定推导或双向映射。 |
| federation txn id | `RemoteServerDO` | no | 同一重试必须复用同一 `txn_id`。 |

## 5. 真相面与派生面边界

### 5.1 Room 真相面

`RoomDO` 必须持有以下权威数据：

* 事件元数据
* 近期 canonical JSON
* `prev_events` / `auth_events` 边
* 当前状态快照
* 当前 membership 视图
* 房间级 ephemeral 当前值
* 房间级 timeline 位置计数器

### 5.2 User 真相面

`UserDO` 必须持有以下权威数据：

* session / refresh token
* devices / device keys / cross-signing
* one-time / fallback keys
* global / room account data
* to-device 队列
* presence 当前值
* `user_stream` 及其位置计数器

### 5.3 Federation 真相面

`RemoteServerDO` 必须持有以下权威数据：

* outbound transactions
* retry state
* inbound transaction dedupe
* gap repair backlog
* remote discovery cache 与远端 key cache 的可恢复副本

### 5.4 派生面

以下数据定义为可重建派生面：

* 搜索索引
* 用户目录
* 公共房间目录
* 媒体目录
* 审计统计
* appservice 投递队列索引

## 6. 一致性矩阵

| Data Class | Consistency | Writer | Reader Model | Recovery Path |
| --- | --- | --- | --- | --- |
| Room event admission | per-room serial | `RoomDO` | 提交后立即对房间真相可见 | R2 archive + replay |
| Current state | per-room serial | `RoomDO` | 同房间读永远读本对象 | snapshot rebuild |
| Session validity | per-user serial | `UserDO` | 所有认证都经 `UserDO` | user export / rebuild |
| One-time key claim | per-user serial | `UserDO` | 至多一次返回 | none; protocol requires correctness |
| Outbound federation txn order | per-server serial | `RemoteServerDO` | 同远端服务器内严格顺序 | DO retry log |
| Search index | eventual | `jobs-worker` from truth events | 默认接受滞后 | full reindex |
| Media object read-after-write | strong | Worker/R2 | 通过 R2 binding 立即可读 | re-upload / manifest repair |
| KV cache | eventual | Worker / jobs | 可读陈旧 | drop cache and refill |

## 7. 热 / 温 / 冷分层规则

### 7.1 热层

热层必须放在 DO SQLite 或内存辅助索引：

* 当前状态
* 近期事件 JSON
* 近期 membership
* 未消费 to-device
* 活跃 session
* 当前 retry / alarm 状态

### 7.2 温层

温层仍可在 DO SQLite，但可弱化查询性能要求：

* 历史事件元数据
* 旧 snapshot 链
* 旧 session tombstones
* 已完成事务记录

### 7.3 冷层

冷层放在 R2：

* 老事件 canonical JSON
* 导出包
* 审计快照
* 大型恢复 manifest

## 8. 缓存与复制规则

* KV 只允许保存 `/.well-known`、远端发现、能力、远端公钥等陈旧可容忍缓存。
* D1 read replication 只允许用于搜索、目录、统计和其他最终一致读。
* 任何需要“刚写就要读到”的衍生查询都必须使用 D1 Sessions API 或直接回真相面。
* R2 若通过带缓存域名公开访问，删除和权限变更必须联动 purge。

## 9. 请求路由模型

| Route Family | Edge Owner | Authority Target | Notes |
| --- | --- | --- | --- |
| `/.well-known/matrix/client` | `gateway-worker` | none | 静态或低频配置；可缓存。 |
| `/.well-known/matrix/server` | `gateway-worker` | none | 联邦发现关键入口。 |
| `/_matrix/client/versions` | `gateway-worker` | none | 公开能力声明。 |
| `/_matrix/client/*` 用户域 | `gateway-worker` | `UserDO` | 登录、刷新、设备、账号数据、keys、to-device。 |
| `/_matrix/client/*` 房间写路径 | `gateway-worker` | `UserDO` then `RoomDO` | 先鉴权与设备确认，再房间裁决。 |
| `/_matrix/client/v3/sync` | `gateway-worker` | `UserDO` + `RoomDO` | Worker 持有 poll，按需投影房间。 |
| `/_matrix/federation/*` 入站事务 | `gateway-worker` | `RoomDO` / `UserDO` / `RemoteServerDO` | 先联邦验签，再分发。 |
| `/_matrix/media/*` | `gateway-worker` | R2 + D1 projection + `UserDO` quota | 上传下载都在 Worker 入口。 |
| `/_matrix/key/*` | `gateway-worker` | signing material service | 与联邦和客户端 keys 相关。 |

## 10. 路由规范

* 所有认证态客户端请求必须先解析 access token 并定位到 `UserDO`。
* 所有房间写请求都必须在 `UserDO` 完成会话/设备校验后进入 `RoomDO`。
* 所有远端联邦交易必须先在 edge 完成 `Authorization: X-Matrix` 验证。
* 所有媒体下载必须优先走 Worker -> R2 binding，不得把 D1 查询作为下载前置单点。

## 11. 完成标准

* 每类数据都有唯一归属；
* 每类一致性语义都能追溯到具体存储与组件；
* 所有入口请求都有明确路由边界；
* 所有 token / cursor / idempotency 规则已挂到具体数据所有者；
* 后续协议分册不再自行定义底层一致性真相。
