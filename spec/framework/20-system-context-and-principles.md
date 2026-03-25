# System Context and Principles Spec

状态：Draft-Normative
角色：架构基础分册  
负责主文档章节：2  
继承的单体章节：6-7

## 1. 文档职责

* 定义系统上下文、外部参与者、外部系统与信任边界。
* 定义整体架构原则，包括正确性、存储、并发、成本、可演进性。
* 定义所有后续分册必须遵守的跨域不变量。

明确不包含：

* 不下沉到具体 Cloudflare 资源绑定；
* 不展开具体协议流；
* 不定义接口或表结构正文。

## 2. 外部参与者与外部系统

### 2.1 外部参与者

| Actor | Trust Level | Primary Interaction | Notes |
| --- | --- | --- | --- |
| Matrix 客户端 | 不可信 | Client-Server API | 只能通过公开 HTTP 路由进入系统。 |
| 本地用户 | 不可信 | 登录、房间操作、媒体、E2EE 传输 | 身份与权限由 `UserDO` 和房间授权共同裁决。 |
| 远端 homeserver | 不可信 | Federation API | 只可信任其签名验证后声明的服务器身份，不可信任其内容语义。 |
| Application Service | 半可信 | AS API | 由显式注册与 namespace 限制其能力边界。 |
| 运维人员 | 可信但需审计 | 内部控制面 | 不允许绕过模型直接改写权威数据。 |
| 安全与合规人员 | 可信但只读优先 | 审计、导出、恢复演练 | 默认不获得业务密钥明文。 |

### 2.2 外部系统

| System | Trust Level | Dependency Type | Notes |
| --- | --- | --- | --- |
| Matrix 规范生态 | 外部权威 | 协议事实 | 本系统实现 Matrix homeserver，不重新定义协议。 |
| Cloudflare Edge Runtime | 平台权威 | 运行时与计费 | 本系统必须服从平台限制，而不是假设平台像传统 VM。 |
| DNS / `/.well-known` 发现链路 | 外部依赖 | 发现 | 客户端与联邦发现均依赖此路径。 |
| R2、D1、KV、Queues | 平台内依赖 | 存储与异步 | 行为边界由 `13` 分册统一定义。 |

## 3. 信任边界

| Boundary | Inside | Outside | Normative Rule |
| --- | --- | --- | --- |
| `BND-001` Public Edge | `gateway-worker` | 客户端、远端 homeserver、AS | 所有公开流量必须先在 edge 层完成基础鉴权、限流、路由、协议版本校验。 |
| `BND-002` Worker-to-DO | `UserDO` / `RoomDO` / `RemoteServerDO` | `gateway-worker` / `jobs-worker` / `ops-worker` | 内部调用可信但不自由；必须遵守显式 RPC/HTTP 契约与版本兼容规则。 |
| `BND-003` Authoritative vs Derived | DO SQLite 真相面 | D1/KV/R2 衍生与缓存面 | 派生面不得反向决定真相。 |
| `BND-004` Operator Boundary | `ops-worker` | 公网与普通客户端 | 控制面默认不暴露公网；如需暴露，必须额外认证与审计。 |
| `BND-005` Secret Boundary | Worker secrets / 签名密钥 | 普通业务代码与日志 | 任何密钥材料都不得以明文进入日志、D1、KV。 |

## 4. 高层上下文模型

系统的规范性上下文如下：

1. 所有公开流量先进入 `gateway-worker`。
2. `gateway-worker` 只负责接入、鉴权、路由、聚合与流式响应，不拥有房间或用户真相。
3. `UserDO(user_id)` 是用户主权状态机。
4. `RoomDO(room_id)` 是房间主权状态机。
5. `RemoteServerDO(server_name)` 是远端服务器出站联邦状态机。
6. D1 只承载衍生查询面。
7. R2 承载对象数据与冷数据。
8. KV 只承载可陈旧缓存。
9. `jobs-worker` 只做异步衍生与补偿，不做权威提交。
10. `ops-worker` 只做内部控制面，不做普通公网业务入口。

## 5. 架构原则

### 5.1 正确性原则

| REQ-ID | Principle | Normative Statement |
| --- | --- | --- |
| `REQ-ARCH-001` | 主权状态机优先 | 房间、用户、远端服务器三类权威状态必须各自拥有唯一串行裁决者。 |
| `REQ-ARCH-002` | 单一真相面 | 任一业务事实只能有一个权威写入位置。 |
| `REQ-ARCH-003` | 协议入口统一 | 同一类 Matrix 语义无论来自本地客户端、联邦还是 AS，都必须进入同一语义裁决管道。 |
| `REQ-ARCH-004` | 提交前不等待外部 I/O | 权威写路径在提交前不得依赖远端网络、D1、KV、Queues 或 R2 的成功。 |
| `REQ-ARCH-005` | 可恢复优先 | 任何衍生副作用失败都必须可通过重放、重建或补偿修复。 |

### 5.2 存储原则

| REQ-ID | Principle | Normative Statement |
| --- | --- | --- |
| `REQ-ARCH-006` | DO SQLite 承载真相 | 需要强一致、串行裁决的数据必须优先放在 DO SQLite。 |
| `REQ-ARCH-007` | D1 仅作衍生查询面 | D1 不得承载房间当前状态、设备会话真相或联邦幂等真相。 |
| `REQ-ARCH-008` | KV 仅作缓存 | KV 不得被视为即时一致或权威来源。 |
| `REQ-ARCH-009` | R2 承载对象与冷历史 | 大对象、冷数据、归档必须移出 DO 热路径。 |

### 5.3 并发原则

| REQ-ID | Principle | Normative Statement |
| --- | --- | --- |
| `REQ-ARCH-010` | 每房间串行 | 同一 `room_id` 的事件接纳与状态推进必须在同一 `RoomDO` 内串行完成。 |
| `REQ-ARCH-011` | 每用户串行 | 同一 `user_id` 的 session、device、to-device、sync stream 必须在同一 `UserDO` 内线性化。 |
| `REQ-ARCH-012` | 每远端服务器串行出站 | 同一 `server_name` 的出站事务排序、重试和去重必须由同一 `RemoteServerDO` 裁决。 |
| `REQ-ARCH-013` | 派生最终一致 | 搜索、目录、统计、媒体目录、导出索引可以滞后，但必须可重建。 |

### 5.4 成本原则

| REQ-ID | Principle | Normative Statement |
| --- | --- | --- |
| `REQ-ARCH-014` | 成本与语义解耦 | 不能通过把权威语义塞进更便宜但不一致的存储来降低成本。 |
| `REQ-ARCH-015` | 长等待在 Worker，不在 DO | 长轮询和稀疏等待应尽量停留在 Worker 或 hibernating DO 连接上。 |
| `REQ-ARCH-016` | 以分片替代纵向堆高 | 扩容优先通过更多主权对象，而不是更重单体实例。 |

### 5.5 可演进原则

| REQ-ID | Principle | Normative Statement |
| --- | --- | --- |
| `REQ-ARCH-017` | 版本偏斜容忍 | Worker 与 DO 接口必须前后兼容，以适应 Cloudflare 渐进和最终一致发布。 |
| `REQ-ARCH-018` | 房间版本隔离 | 房间版本差异必须通过策略层隔离，不得散落在业务代码中。 |
| `REQ-ARCH-019` | 协议与平台事实分离 | Matrix 语义与 Cloudflare 平台限制必须分开建模，然后在责任分册中组合。 |

## 6. 全局不变量

* `INV-001` 任一房间事件只有在 `RoomDO` 成功提交后，才可对本地 `/sync`、搜索、联邦出站可见。
* `INV-002` 任一用户可见的 `/sync` token 只能表示已稳定提交的用户流位置。
* `INV-003` D1、KV、Queues、R2 中的失败都不得让真相面进入“部分提交”状态。
* `INV-004` 本地客户端写入与联邦写入必须在同一房间授权和状态解析实现上裁决。
* `INV-005` 任何对象被冷化或归档后，热层仍必须保留恢复和分页所需最小索引。
* `INV-006` 任何内部接口变更都必须兼容至少一个正在运行的旧版本调用方或被调方。
* `INV-007` 任何媒体对象只要对客户端或联邦可见，就必须能在不依赖 D1 的情况下完成最小读取与鉴权判断。

## 7. 对后续分册的约束输出

* `21` 分册必须把三类主权对象和三类 Worker 的边界落到运行时组件。
* `22` 分册必须把每种数据放到唯一真相面或派生面。
* `23` 分册必须为所有跨边界交互定义显式契约。
* `30-34` 分册必须基于本分册不变量定义各责任域行为，不得重新解释全局原则。

## 8. 完成标准

* 系统边界与外部依赖闭合；
* 每项架构原则可被后续分册引用；
* 原则已能约束接口、数据、流程与测试；
* 全局不变量可用于审查各域设计。
