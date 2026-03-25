# Federation Spec

状态：Draft-Normative
角色：联邦分册  
负责主文档章节：4  
继承的单体章节：15，9.6

## 1. 文档职责

* 定义服务器发现、委派、签名、密钥、交易、恢复与重试。
* 定义联邦入站、出站、缺失事件恢复、媒体联邦边界。
* 定义 `RemoteServerDO` 的职责、队列和重试模型。

明确不包含：

* 不定义房间内部状态解析正文；
* 不定义本地客户端同步正文；
* 不定义通用安全治理正文。

## 2. 联邦运行时边界

* `gateway-worker` 负责联邦公开入口、`X-Matrix` 验签、路由与最小协议编排。
* `RoomDO` 负责房间 PDU 的最终语义裁决。
* `UserDO` 负责用户域 EDU、to-device 与设备键相关语义。
* `RemoteServerDO(server_name)` 负责对单一远端服务器的出站排序、重试、去重和恢复。

## 3. 发现与委派

### 3.1 出站发现算法

对远端 `server_name` 的发现必须遵循 Matrix 官方流程，规范性顺序如下：

1. 若 `server_name` 已显式带端口，则直接使用该主机与端口。
2. 否则检查 `/.well-known/matrix/server` 是否存在委派。
3. 否则检查 SRV 记录。
4. 若仍无结果，则回退到直接连接 `server_name:8448`。

### 3.2 本地入站暴露规则

由于 Cloudflare 代理标准 HTTPS 端口包含 `443` 与 `8443`，但不包含 `8448`，本系统必须满足以下之一：

* 直接在 `443` 暴露联邦入口；
* 或在 `8443` 暴露，并通过 `/.well-known/matrix/server` 或 SRV 委派；
* 不允许假设远端一定会直连 `8448`。引用：`CF-NET-001`,`CF-NET-002`。

## 4. 签名与密钥管理

### 4.1 本地签名材料

* 本地服务器签名密钥必须保存在 Worker secrets，不得存入 D1、KV 或日志。
* 服务器必须发布当前验证密钥与必要的旧密钥，直到其不再需要验证历史签名。

### 4.2 远端验证密钥

* 远端验证密钥的获取与缓存由 `RemoteServerDO` 协调。
* 远端 key cache 可以存在 KV 副本，但权威可用副本必须留在 `RemoteServerDO` 或可恢复控制面。
* key cache 过期或验签失败时必须回源重新抓取，而不是永久相信旧缓存。

## 5. 入站事务

### 5.1 Inbound `send`

`PUT /_matrix/federation/*/send/{txnId}` 处理顺序必须为：

1. 解析并验证 `Authorization: X-Matrix`。
2. 定位 `origin` 对应 `RemoteServerDO` 并执行 `{origin,txn_id}` 去重。
3. 将 PDUs 分发到对应 `RoomDO`。
4. 将 EDUs 分发到 `UserDO` 或其他目标域。
5. 汇总 per-PDU 处理结果并返回。

### 5.2 幂等要求

* 重复的 `{origin,txn_id}` 必须稳定返回等价结果。
* 同一事务内单个 PDU 的失败不得强制整批回滚；但重复提交时其结果必须可复现。
* `{origin,txn_id}` 的去重不仅要记录“见过”，还必须通过 `DATA-FED-006` 持久化 canonical request hash 与 canonical response bytes；同键同内容重试必须短路返回缓存响应，同键不同内容必须显式冲突失败。

## 6. 出站事务

### 6.1 `RemoteServerDO` 是唯一排序点

* 所有发往同一 `server_name` 的 PDUs/EDUs 都必须先进入 `DATA-FED-001`。
* `RemoteServerDO` 每次只允许一个活跃发送事务，以保持远端感知顺序稳定。

### 6.2 打包规则

* 一个事务可以包含多个 PDUs/EDUs，但 payload 一旦持久化即不可变。
* 打包器必须受以下约束：
  * 不得无限等待“更多消息”而阻塞已就绪消息；
  * 不得把过大的 JSON payload 组装进单事务；
  * 发送失败时必须复用同一 `txn_id` 和同一 payload 重试。

### 6.3 出站入口

* 房间 PDU 由 `RoomDO` 通过 `IF-INT-FED-001` 入队。
* 用户域 EDU 或 to-device 由 `UserDO` 通过同一内部契约入队。

## 7. 缺事件恢复与 Backfill

### 7.1 触发条件

以下场景必须触发 gap repair：

* 缺失 `prev_events`
* 缺失 `auth_events`
* state resolution 所需上下文不完整
* 远端加入握手需要补状态

### 7.2 恢复策略

`RemoteServerDO` 必须按如下优先级协调恢复：

1. `get_missing_events`
2. `event` / `state_ids` / `state`
3. `backfill`

恢复取得的数据仍必须重新进入 `RoomDO` 统一准入管道。

### 7.3 等待模型

* 等待恢复的事件必须持久化在 `STATE-ROOM-EVENT-ADMISSION` 的 `waiting-missing` 分支。
* 恢复完成后，`RoomDO` 重新尝试准入，不允许用“跳过事件”来前推房间状态。

## 8. 重试、退避与隔离

### 8.1 退避模型

`RemoteServerDO` 必须使用指数退避加抖动，并满足：

* 首次失败后快速重试，便于吸收短抖动；
* 之后增长到最大退避上限；
* 长期失败进入 `degraded` 可观测状态，但不永久停止；
* 重试调度由 `IF-ALARM-001` 驱动。

### 8.2 隔离原则

* 单个远端服务器的失败不得阻塞其他远端服务器。
* 同一远端服务器的慢请求不得阻塞 `gateway-worker` 公网请求线程。
* 远端发现失败、TLS 失败、签名失败、语义失败必须分别统计，不能混成一个“联邦失败”。

## 9. 联邦查询面

### 9.1 Scope

以下 surface 属于联邦查询面，而不是 repair/backfill 面：

* `/_matrix/federation/*/hierarchy/{roomId}`
* `/_matrix/federation/*/query/directory`
* `/_matrix/federation/*/query/profile`
* `/_matrix/federation/*/query/{queryType}`

这些请求必须统一归入 `IF-FED-006`，不得复用 client profile 接口，也不得复用 `IF-FED-004` 的缺事件恢复路径。

### 9.2 Dispatch 规则

* `hierarchy` 与 `query/directory` 可以以 `DATA-D1-003` 作为 fast path，但任何可见性不确定场景都必须 fail-closed，而不是把潜在私有房间暴露给远端。
* “可见性不确定” 至少包括：目录行缺失但 `RoomDO` 明确存在、目录行的 source watermark 落后于当前房间真相、目录 rebuild 正在进行、或决定公开性所需的 join rules / history visibility / world readable / published 标记任一缺失。
* 遇到可见性不确定时，实现只能执行两种动作：回退读取 `RoomDO` 真相后再裁决，或直接返回 endpoint 允许的 `403/404`；不得猜测公开，也不得返回未经确认的部分结果。
* `query/profile` 必须读取本地 `DATA-USER-012` profile truth，并应用 Matrix 允许的 profile 可见性规则；`field` 只允许 `displayname` 或 `avatar_url`，响应也只允许返回这两个字段。
* `query/{queryType}` 只允许显式登记并实现的 query types；未知 query type 必须返回明确联邦错误，不得透传到 client handler。
* 所有联邦查询都必须先完成 `X-Matrix` 验签与目标 server name 检查，再进入只读 dispatch。

## 10. 联邦媒体

* 远端媒体拉取属于媒体域功能，但其远端发现与出站连接约束受本分册管理。
* 单个请求中的远端抓取并发必须显式受限，以避免触碰 `6` 个 open connections 上限。引用：`CF-WKR-006`。
* 远端媒体一旦成功拉取，必须落 R2 并生成本地缓存元数据，再返回给客户端。

## 11. Cloudflare 贴合规则

* 联邦发现设计必须明确兼容 `443`/`8443` + `/.well-known`，不得把 `8448` 作为部署前提。引用：`CF-NET-001`。
* 所有联邦入站和出站实现都必须容忍 Worker/DO 版本偏斜。引用：`CF-DO-005`。
* 联邦长恢复与大 backfill 不能在单次公网请求里完成，必须拆成 `RemoteServerDO` + alarm/queue 工作。引用：`CF-WKR-003`。

## 12. 联邦域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| discovery / well-known | `IF-PUB-002`,`IF-FED-001` | none | `DATA-FED-005`,`DATA-KV-002` |
| inbound transactions | `IF-FED-002` | `IF-INT-FED-002`,`IF-INT-ROOM-001` | `DATA-FED-003`,`DATA-FED-006`,`DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` |
| outbound transactions | remote HTTP push | `IF-INT-FED-001`,`IF-ALARM-001` | `DATA-FED-001`,`DATA-FED-002` |
| join/leave/knock | `IF-FED-003` | `IF-INT-ROOM-001` | `DATA-FED-004`,`DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` |
| repair/backfill | `IF-FED-004` | `IF-ALARM-001` | `DATA-FED-004` |
| query surfaces | `IF-FED-006` | none | `DATA-USER-012`,`DATA-D1-003`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007` |

## 13. 完成标准

* 发现与委派规则可直接实现；
* 入站、出站、恢复三条路径闭合；
* 联邦查询与 repair/backfill 面已明确分离；
* 联邦重试与隔离规则明确；
* 联邦域已接入接口、数据、流程目录；
* 房间域与联邦域的边界没有重叠。
