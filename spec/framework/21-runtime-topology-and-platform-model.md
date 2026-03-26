# Runtime Topology and Platform Model Spec

状态：Draft-Normative
角色：平台架构分册  
负责主文档章节：2-3  
继承的单体章节：8-9

## 1. 文档职责

* 定义 Worker、Durable Object、D1、KV、R2、Queues、Service Bindings 的使用拓扑。
* 定义 `gateway-worker`、`jobs-worker`、`ops-worker` 的边界。
* 定义各 Durable Object 类别与责任分工。
* 定义 Cloudflare 平台硬约束、软约束与适配规则。
* 定义 bounded context 到运行时组件的落位关系。

明确不包含：

* 不展开实体级数据模型；
* 不展开协议消息语义；
* 不展开成本测算正文。

## 2. 运行时总览

规范性运行时拓扑固定如下：

* Matrix 协议公网面只暴露 `gateway-worker`。
* 异步处理与重建由 `jobs-worker` 执行。
* Access 保护的管理面由 `ops-worker` 执行。
* 所有权威业务状态由 DO 类承载。
* 所有 Worker-to-Worker 通信必须使用 Service Bindings，且调用必须被显式 `await`。
* 所有 Worker-to-DO 通信默认使用 DO RPC；只有 upgrade 或协议透传场景才允许 HTTP `fetch()`。

## 3. Worker 角色模型

| Component | Exposure | Primary Responsibilities | Forbidden Responsibilities | Key CF References |
| --- | --- | --- | --- | --- |
| `gateway-worker` | public | 路由、基础鉴权、联邦签名校验、`/.well-known`、`/sync` 长轮询、媒体流式转发、聚合响应 | 不得成为房间/用户真相拥有者；不得在热路径内执行长 CPU 作业 | `CF-WKR-001`,`CF-WKR-006`,`CF-WKR-007` |
| `jobs-worker` | internal | Queue consumer、缩略图、索引、导出、重建、补偿 | 不得独立创造权威业务事实；不得绕过 DO 改写真相 | `CF-WKR-003`,`CF-QUE-002` |
| `ops-worker` | access-protected admin | 健康检查、迁移编排、修复、回放、审计导出、运维接口 | 不得替代 Matrix 公网 API；不得通过临时脚本直接修改 DO 真相表 | `CF-WKR-012`,`CF-DO-006`,`CF-NET-003` |

### 3.1 `gateway-worker` 公开路由面

`gateway-worker` 必须接收以下路由族：

* `/_matrix/client/*`
* `/_matrix/federation/*`
* `/_matrix/media/*`
* `/_matrix/key/*`
* `/.well-known/matrix/client`
* `/.well-known/matrix/server`

### 3.2 Worker 内部调用规则

* `gateway-worker -> jobs-worker`：仅用于异步任务投递、非权威查询聚合、后台补偿触发。
* `gateway-worker -> ops-worker`：禁止普通业务调用。
* `ops-worker -> jobs-worker`：允许用于重建、导出、批量校验。
* 任一需要 fire-and-forget 语义的异步派发必须走 Queues 或其他显式 durable mechanism；禁止依赖未 `await` 的 Service Binding 调用。

## 4. Durable Object 类模型

| DO Class | Identity Key | Authority Domain | Primary Responsibilities | Forbidden Responsibilities |
| --- | --- | --- | --- | --- |
| `UserDO` | `user_id` | 用户 | user principal / password credential、session、refresh token、device、account data、to-device、one-time/fallback keys、presence、用户增量流 | 不裁决房间状态；不直接做联邦重试排序 |
| `RoomDO` | `room_id` | 房间 | 事件准入、DAG、state、auth、membership、timeline、receipt/typing 当前视图、房间投影 | 不持有客户端长轮询；不做跨房间全局搜索 |
| `RemoteServerDO` | `server_name` | 远端服务器 | 出站事务队列、退避重试、联邦去重、缺事件恢复调度、远端发现缓存 | 不裁决房间 auth/state；不拥有本地用户设备真相 |

### 4.1 `UserDO` 设计规则

* 所有 access token 和 refresh token 的有效性判断必须经过 `UserDO`。
* 本地 password credential、deactivated 状态与 `auth_version` 必须只存在于 `UserDO` 主记录，不得复制到 Worker 内存或 D1 作为认证真相。
* `/keys/claim` 语义必须由 `UserDO` 线性化，以保证 one-time key 至多返回一次。
* `UserDO` 产生的 `user_stream_pos` 是 `/sync` 的唯一权威用户流基准。

### 4.2 `RoomDO` 设计规则

* 所有进入房间的事件必须进入同一 `RoomDO` 准入流水线。
* `RoomDO` 提交前不得等待 D1、R2、Queue 或远端网络完成。
* `RoomDO` 需要提供房间投影接口，但不得直接输出完整 `/sync` 响应。

### 4.3 `RemoteServerDO` 设计规则

* 每个远端服务器只有一个出站排序点。
* 对同一事务 ID 的重试必须复用同一 payload。
* 远端发现结果可缓存，但不得跳过 Matrix 官方发现流程。

## 5. Supporting Storage Systems

| Store | Role | Allowed Uses | Forbidden Uses |
| --- | --- | --- | --- |
| DO SQLite | authoritative | 用户、房间、远端服务器真相；幂等；游标；状态机持久化 | 大对象媒体本体；全局全文搜索 |
| D1 | derived query plane + authoritative control-plane metadata | 搜索、目录、媒体目录、AS 控制面、operator authz、审计/registry/job metadata、统计 | 房间当前状态真相、会话真相、联邦事务真相、任何需要数据面主权对象串行裁决的业务真相 |
| R2 | blob / cold / archive | 媒体对象、缩略图、冷历史、导出、灾备包 | 强一致事务协调 |
| KV | cache | `/.well-known` 缓存、远端 key 缓存副本、非关键能力缓存 | 会话撤销、房间状态、媒体存在性真相 |
| Queues | async fanout | 索引、缩略图、导出、重建、补偿任务 | 权威事务提交 |

## 6. 异步处理拓扑

### 6.1 允许的异步源

* `RoomDO` 提交事件后发出索引、联邦出站、用户 fanout 工作项。
* `UserDO` 提交设备、账号数据后发出目录、通知、缓存刷新工作项。
* 媒体上传完成后发出缩略图、审计、生命周期工作项。
* `RemoteServerDO` 失败重试通过 DO alarm 自驱。

### 6.2 异步规范

* 所有 Queue 负载必须可幂等重放。
* 所有 Queue 负载必须有稳定去重键。
* 队列失败只能造成衍生面滞后，不得造成真相损坏。
* 任一长作业必须支持分片和断点续跑，以适应 `15 min` 运行上限。引用：`CF-WKR-003`,`CF-QUE-002`。

## 7. Cloudflare 使用规则

### 7.1 Worker 使用规则

* `gateway-worker` 默认 CPU 限额按热路径设计在 `30s` 默认值之内；只有特殊导出或诊断入口才允许更高上限。引用：`CF-WKR-003`。
* 所有大对象读取与转发必须使用 stream，不得完整读入内存。引用：`CF-WKR-004`。
* 若通过 `fetch`、R2、KV、Queues 或 D1 打开连接后不再需要响应体，必须显式取消或尽快读尽；网络 I/O 受 `CF-WKR-006` 约束，D1 并发连接另受 `CF-D1-009` 约束。
* 内部 RPC 链必须限制为浅层拓扑：`gateway -> DO` 或 `gateway -> jobs -> DO`，禁止多跳扇出图。引用：`CF-WKR-009`。
* Service Binding 调用计入 subrequest 与 `32` 次 Worker invocation 上限，调用本身不单独占用 open-connection slot；但由同一 top-level request 触发的全部 Worker 仍共享同一组 `6` 个 simultaneous open connections 预算。不得把拆分 Worker 当作扩大连接并发的手段。引用：`CF-WKR-009`,`CF-WKR-010`。
* Service Binding RPC 只适用于明确需要结果的同步内部调用；任何未 `await` 的绑定调用都视为错误实现。引用：`CF-WKR-009`,`CF-WKR-010`。

### 7.2 DO 使用规则

* 所有 DO 构造函数必须只做最小初始化，不得在构造阶段执行高成本扫描。引用：`CF-DO-004`,`CF-DO-009`。
* DO schema 变更必须以向前兼容读 + 延迟回填或单独迁移完成。引用：`CF-DO-005`,`CF-DO-006`。
* 大量批处理写入必须分批提交并施加背压。引用：`CF-DO-008`。
* 所有 authority handler 必须在业务处理早期触碰 durable storage，以强制 currentness 并尽早暴露 not-current 条件；禁止把“长时间只靠内存/WS attachment 且延迟首次存储访问”的逻辑当作安全的单实例串行路径。引用：`CF-DO-014`。

### 7.3 D1 / KV / R2 使用规则

* 任何要求 read-after-write 的路径不得依赖 D1 普通查询。引用：`CF-D1-003`,`CF-D1-004`。
* 单次 invocation 使用 D1 时，必须同时满足“最多 `1,000` 条 queries”“单 SQL 最长 `30s`”“最多 `6` 个 D1 connections”三条边界。引用：`CF-D1-007`,`CF-D1-008`,`CF-D1-009`。
* KV key 只允许保存“陈旧可接受”的缓存。引用：`CF-KV-001`,`CF-KV-002`。
* R2 下载路径必须优先使用 Worker binding，不得把缓存域名的一致性当成真相。引用：`CF-R2-001`,`CF-R2-004`。

## 8. Bounded Context Allocation

| Bounded Context | Runtime Owner | Secondary Components | Notes |
| --- | --- | --- | --- |
| Identity / Devices / Sessions | `UserDO` | `gateway-worker`, D1 derived index | 以 `user_id` 分片。 |
| Sync / Notifications | `UserDO` + `gateway-worker` | `RoomDO` projections | Worker 持有长轮询，UserDO 提供流。 |
| Rooms / State / Membership | `RoomDO` | `UserDO`, `RemoteServerDO`, R2 cold archive | 以 `room_id` 分片。 |
| Federation outbound | `RemoteServerDO` | `gateway-worker`, `RoomDO`, `UserDO` | 以 `server_name` 分片。 |
| Media | `gateway-worker` + R2 | D1 media catalog, `jobs-worker` | 对象真相在 R2。 |
| Search / Directory | D1 derived plane | `jobs-worker`, `ops-worker` | 完全可重建。 |
| Application Services | `jobs-worker` / D1 control plane | 可选 `AppServiceDO` | 首版可不单独建 DO。 |
| Operations / Recovery | `ops-worker` | `jobs-worker`, all DO classes | 仅内部使用。 |

## 9. 失败域与爆炸半径

| Failure Domain | Typical Failure | Containment Strategy |
| --- | --- | --- |
| 单个 `RoomDO` | 热房间 CPU 飙升、单房间历史过大 | 房间级隔离；限流、冷化、分房治理 |
| 单个 `UserDO` | 单用户大量设备或 to-device 洪泛 | 用户级隔离；设备数、队列深度、批量收割 |
| 单个 `RemoteServerDO` | 某远端服务器长期失败或慢 | 远端级隔离；独立退避，不阻塞其他服务器 |
| D1 单库 | 搜索或目录写入拥堵 | D1 不承载真相；允许滞后并支持分库 |
| Queue backlog | 缩略图/索引积压 | 只影响衍生面，不影响房间/用户真相 |
| Worker deployment skew | 新旧版本接口不一致 | 严格前后兼容；迁移分离发布 |

## 10. 控制面放置

* 运维入口默认通过 `ops-worker` 暴露。
* `ops-worker` 只能通过专用管理域访问；该域在网络层可达，但必须被视为 Access 保护的管理面，而不是内部私网入口。
* 人类入口必须经 Cloudflare Access；自动化入口必须经 Access service token 或等价受限凭据。
* 所有修复、回放、重建动作都必须通过显式作业对象和审计日志执行，不允许临时脚本直写 DO 存储。

## 11. 完成标准

* 每个 Cloudflare 原语有唯一主责；
* 每个 bounded context 有唯一运行时落位；
* 平台硬限制已经映射到设计约束；
* 所有平台性断言都已回链 `CF-ID`；
* 后续协议分册可直接引用本册组件边界。
