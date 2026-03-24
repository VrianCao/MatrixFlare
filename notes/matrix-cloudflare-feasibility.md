# 在 Cloudflare 边缘网络上实现 Matrix 规范服务器的可行性评估

日期：2026-03-24  
规范基线：`https://spec.matrix.org/latest/`，当前 latest 路由解析到 `v1.17`

## 本轮范围

本轮评估的目标被收窄为：

* 只评估 **Matrix homeserver**
* 对标的是 `Synapse`、`Conduwuit/Continuwuity` 这一类 homeserver 角色，而不是 Matrix 生态中的全部独立服务角色
* 已知部署条件为 **Cloudflare Workers Paid Plan**
* 允许使用 Cloudflare 套件：Workers、Durable Objects、D1、KV、R2、Queues、Workflows

因此，下文中的“完全符合”默认是指：

* 完整 homeserver 口径下的 `Client-Server API`
* `Server-Server API`
* 与 homeserver 强耦合的 `Application Service API`

而不再把 `Identity Service`、`Push Gateway`、外部 TURN 基础设施等独立角色作为主结论的阻塞项。

## 结论先行

如果目标是一个运行在 **Cloudflare Workers Paid Plan** 上的 **完整 Matrix homeserver**，并覆盖最新规范中的 `Client-Server API`、`Server-Server API`、以及与 homeserver 强耦合的 `Application Service API`，那么结论是：

**可行。**

但这个“可行”有四个非谈判前提：

1. **Durable Objects 必须是主权状态层**  
   房间状态裁决、用户设备与 `/sync` 游标不能落在 D1 或 KV 上。
2. **D1 只能做索引层**  
   搜索、目录、统计、后台查询可以用 D1，但 D1 不能决定某个房间事件是否有效。
3. **R2 必须承担媒体与冷历史**  
   否则单个 Room DO 的 10GB 上限迟早成为结构性问题。
4. **必须接受单房间吞吐天花板**  
   单房间主权天然会被单个 Room DO 串行化，这与 Matrix 协议相容，但不是无限扩展模型。

在这个范围下，最大的难点不是 Cloudflare 平台能力不足，而是：

* Matrix 房间状态机本身复杂；
* `/sync` 是一个高复杂度增量分发系统；
* 联邦错误恢复、缺事件回填、去重与重试必须设计得非常严谨。

## 评估口径

本评估刻意不参考既有 Matrix 实现，而是从第一性原则出发，只问两个问题：

1. Matrix 协议要求服务器维持什么样的状态机与一致性语义？
2. Cloudflare 的执行与存储原语，能否原生承载这些语义？

因此，本评估的核心不是“能不能把 API 跑起来”，而是：

* 能不能在联邦环境下正确裁决事件；
* 能不能在多地域边缘执行环境中维持房间状态一致；
* 能不能在异步、重复、乱序、恶意输入下保持规范要求的行为。

## 第一性原则：Matrix 服务器到底在做什么

从协议本质上看，一个 Matrix homeserver 不是普通 REST 应用，而是以下五类机器的叠加：

1. **按房间串行裁决的分布式状态机**
   每个房间都是一个带鉴权规则的事件 DAG。新事件是否可接受，取决于现有房间状态、auth chain、room version 规则以及 state resolution 结果。

2. **按用户/设备维护的增量同步引擎**
   `/_matrix/client/v3/sync` 不是简单列表接口，而是一个按 token 增量投递、带 presence / to-device / account_data / receipts / device_lists / unread counts 的个性化流。

3. **按对端服务器维护的异步联邦传输系统**
   `Server-Server API` 要求处理签名、去重、重试、事务边界、PDU/EDU、服务器发现、密钥发布与拉取。

4. **大对象与冷数据仓库**
   媒体、缩略图、远端媒体缓存、房间历史冷段、状态快照，都不是适合放进内存或小行数据库里的数据。

5. **次级索引与搜索系统**
   `/search`、用户目录、public rooms 目录、通知计数、未读统计，本质上都是衍生索引而不是房间主权状态。

从这里可以直接推出一个关键设计要求：

**Matrix 不需要“全局强一致数据库”，但它绝对需要“按房间”和“按用户”两个维度的线性化主权。**

## Cloudflare 原语与协议需求的匹配

### Workers

适合承担：

* HTTP 入口；
* `/.well-known`；
* client-server 与 federation 的路由层；
* 鉴权、签名校验、速率限制、流式响应；
* 与 Durable Objects / R2 / D1 的编排。

与 Matrix 的匹配点：

* HTTP 请求无硬性 wall-time 限制，只要客户端不断开，就适合 long-poll 的 `/sync`；
* 响应体不限大小，适合媒体下载与历史回放；
* CPU 时间默认 30 秒，可提高到 5 分钟，足够覆盖多数单次事件处理与联邦校验。

Paid Plan 对本题尤其关键的加成是：

* 单次请求默认 10,000 个子请求额度，而不是 Free 的 50；
* CPU 时间上限可提升到 5 分钟，而不是 Free 的 10ms；
* Durable Objects、D1、R2 的可用规模和账户级限制都更接近“正式系统”而不是“演示系统”。

需要注意：

* 每次 Worker 调用最多 6 个并发外连，这会限制一次请求内的多路联邦抓取和多存储扇出；
* 请求体大小受 Cloudflare 套餐限制，默认上限 100MB 到 500MB，这意味着媒体上传能力必须通过 `m.upload.size` 明确宣告，而不能假定无限制。

### Durable Objects

这是整个方案能否成立的关键。

Durable Object 提供了三个对 Matrix 极其关键的性质：

1. **单对象单线程**
   这天然满足“同一房间事件裁决必须串行”的需求。

2. **对象级持久状态**
   房间当前状态、auth frontier、membership 视图、设备清单等都可以作为对象局部真相。

3. **按 key 路由到唯一主权实例**
   这使“房间 -> 唯一裁决者”“用户 -> 唯一账户状态机”成为天然模型，而不是后补的分布式锁。

因此，若要在 Cloudflare 上做 Matrix，最自然的主权划分是：

* `Room DO`：每个房间一个对象，负责事件接纳、state resolution、membership、事件顺序、联邦入站裁决；
* `User DO`：每个用户一个对象，负责设备、访问令牌、to-device、account data、push rules、presence 聚合；
* `Remote Server DO`：每个远端服务器一个对象，负责服务器发现缓存、出站事务队列、重试、对端签名键缓存；
* 可选 `Media DO` / `Index DO`：负责局部索引协调，而非大对象存储本体。

这不是“方便”的设计，而是**从协议结构直接推导出的设计**。

### D1

D1 不适合充当房间状态主库，原因很直接：

* 单个 D1 数据库本质上也是单线程处理查询；
* 单库 10GB 上限；
* 使用 read replication 时，副本复制是异步的，文档明确说明副本可能“任意程度地过时”，只能通过 Sessions API 获得会话内顺序一致性；
* 这不满足房间事件裁决所需的“当前权威状态”语义。

因此 D1 的正确位置是：

* 全局或分片的次级索引；
* 用户目录；
* 搜索索引；
* public room 目录；
* 审计、运营、后台管理查询；
* 冷数据元数据索引。

一句话：

**D1 适合回答“查”，不适合回答“裁”。**

### KV

KV 明确是 eventual consistency，跨地域可延迟 60 秒甚至更久，而且不适合原子读写事务。

因此 KV 只能做：

* `/.well-known` 或配置缓存；
* 对端服务器发现缓存；
* 远端公钥正缓存；
* 派生能力缓存；
* 热读多、写少的目录类数据。

KV 绝不能做：

* 房间当前状态；
* membership 主真相；
* 设备列表主真相；
* 联邦事务去重主真相；
* token 游标主真相。

### R2

R2 的强一致性使它非常适合承载 Matrix 中所有“大而冷”的不可变数据：

* 媒体文件；
* 缩略图；
* 远端媒体缓存；
* 房间历史冷段；
* 事件批归档；
* 房间状态快照；
* 搜索分段文件；
* 导出备份。

R2 不适合作为房间实时裁决面，但非常适合作为持久归档面。

## 协议能力逐项评估

## 1. Client-Server API

### 账户、登录、设备、令牌

可行。

原因：

* 这些状态天然按用户串行，`User DO` 正好匹配；
* 访问令牌与 refresh token 校验可以在 Worker 前门完成，主真相落在 `User DO`；
* 设备列表变更需要通过 `/sync` 推给其他用户的客户端，这也符合 `User DO -> room fanout -> target User DO` 的传播模型。

### `/sync`

可行，但这是实现复杂度最高的客户端接口之一。

协议本质要求服务器维护每个设备的增量游标，并在一次响应中混合：

* 房间 timeline；
* state；
* ephemeral；
* account_data；
* to-device；
* presence；
* device_lists；
* 通知与未读计数。

在 Cloudflare 上的正确实现方式不是“查很多表拼 JSON”，而是：

* 每个设备维护一个可重放的逻辑 token；
* 用户维度的增量流由 `User DO` 维护；
* 房间维度的增量由 `Room DO` 输出；
* `/sync` 只是把多个局部流合并成设备视角的单一增量结果。

由于 Workers 对 HTTP 请求没有硬 wall-time 限制，long-poll 行为在平台上是成立的。

### E2EE 密钥流：`/keys/upload`、`/keys/query`、`/keys/claim`

可行。

原因：

* 服务器对端到端加密负载本身并不需要解密，只需存储、签名校验、转发与计数；
* one-time keys、fallback keys、cross-signing、key backup 都是“按用户/设备维护的受限状态”，适合 `User DO`；
* 远端设备查询由联邦层透传即可。

真正困难的不是平台，而是协议细节的完整性：过期、覆盖、幂等、签名与设备变更传播。

### 搜索：`/search`

可行，但不适合直接压在 Room DO 上。

建议：

* 房间事件写入时异步投递搜索任务；
* 用 D1 分片做倒排/FTS；
* Room DO 只负责产生规范化事件文本与可见性边界；
* 搜索层负责按用户可见房间集合做过滤。

### 媒体能力与上传大小：`m.upload.size`

可行，但必须与 Cloudflare 请求体限制对齐。

这意味着：

* 媒体上传上限不应大于入口 Worker 可接受的请求体大小；
* 服务器应明确在 `/media/config` 中公开 `m.upload.size`；
* 超大文件若要支持，需要协议层之外的额外分片上传设计，但这不属于 Matrix 标准上传接口本身。

### VoIP / TURN

规范中的 `GET /_matrix/client/v3/voip/turnServer` 是可选模块，不是 homeserver 核心阻塞项。

结论：

* 返回 TURN 凭证接口本身可实现；
* 但“只用 Cloudflare 自家套件”并不能原生提供 TURN 服务器；
* 因此若把“内建 TURN 能力”算进总方案能力，则需要外部系统。

## 2. Server-Server API（联邦）

### 服务器发现

可行，但必须接受一个现实：

**不要把你的联邦入口建立在直连 8448 上。**

Matrix 规范允许通过 `/.well-known/matrix/server` 与 SRV 记录做发现；Cloudflare 代理支持的 HTTPS 端口中包含 `443` 和 `8443`，不包含标准的 `8448` 直入假设。

因此最稳妥的做法是：

* 用户可见 server name 保持标准域名；
* 通过 `/.well-known/matrix/server` 委派到实际联邦入口；
* 联邦入口跑在 `443` 或 `8443`；
* 出站联邦请求在 Workers 中显式使用目标端口。

这不是降级，而是利用规范允许的发现机制。

### 签名、公钥发布、远端公钥获取

可行。

要求：

* 本地签名主密钥必须稳定持久；
* `/_matrix/key/v2/server` 必须可高可用发布；
* 远端公钥缓存必须有 TTL、撤销与 not-before 语义，不能只靠 KV 的最终一致缓存。

合适做法：

* 私钥材料用 Secrets + 受控轮换；
* 当前与历史公钥元数据放 `Remote Server DO` 或专用 `Key DO`；
* KV 只做读取加速缓存。

### PDU / EDU 入站、出站事务、重试、幂等

可行。

这是 Cloudflare 很适合的一块，因为联邦本来就是异步消息传输。

推荐模型：

* 每个远端 homeserver 一个 `Remote Server DO`；
* 它维护出站事务队列、txn id 去重表、重试时钟、退避状态；
* `Room DO` 在本地裁决通过后，把待发送事件写入相关远端服务器 DO；
* 远端服务器 DO 聚合成 `/send/{txnId}` 事务发送；
* 入站事务先经 federation Worker 验签，再分发给对应 Room DO / User DO。

这基本贴合规范本体。

### 房间状态解析与事件鉴权

理论上可行，工程上最难。

原因不是 Cloudflare 不支持，而是 Matrix 的房间语义本身就很难：

* 事件不是线性日志，而是 DAG；
* 当前状态会被 room version 改写；
* state resolution 需要对冲突状态集合做算法性裁决；
* 联邦输入可能重复、乱序、缺前序事件、甚至恶意构造。

Cloudflare 上可行的原因在于：

* 单房间单 DO 天然提供串行入口；
* 复杂 CPU 可用更高的 `cpu_ms` 配额；
* 冷历史与快照可放 R2；
* 缺失事件回填可由异步联邦抓取完成。

真正的风险不是“能不能做”，而是“是否能在热点房间和超长历史上持续做对”。

## 3. Application Service API

可行。

Application Service 与 homeserver 的关系，本质是“带命名空间约束的受信代理用户”。

这对 Cloudflare 来说不是难点：

* 命名空间校验可在 Worker 层完成；
* 用户代入/masquerade 语义由 `User DO` 和 `Room DO` 执行；
* 事件回推给 AS 用出站 HTTP 即可。

它增加的是实现面，不增加平台层 blocker。

## 4. 超出本轮范围的服务角色

本轮目标是 homeserver，因此以下能力不应作为当前主结论的 blocker：

* 独立 `Identity Service`
* 独立 `Push Gateway`
* 自建 TURN 基础设施

之所以把它们单独列出来，是为了避免范围再次漂移：

* homeserver 可以与这些角色对接；
* 但它们并不是 homeserver 本体正确性的核心组成部分；
* 若未来要做“全生态一体化”，才需要重新评估 Cloudflare-only 的闭环能力。

## 为什么 DO 是主权层，而 D1/KV 不是

可以把 Matrix 的数据分成三层：

### A. 主权状态

要求线性化、不可乱序裁决：

* 房间当前状态；
* 事件接纳与拒绝；
* membership；
* 用户设备清单；
* one-time key 计数；
* token 游标。

这层必须进 DO。

### B. 衍生索引

要求可查询、可重建：

* 搜索；
* 用户目录；
* public room 目录；
* 通知汇总；
* 统计报表。

这层适合 D1。

### C. 大对象与冷历史

要求强一致对象读写与低成本归档：

* 媒体；
* 缩略图；
* 远端媒体缓存；
* 历史段；
* 快照。

这层适合 R2。

KV 不属于以上三层的主路径，只属于缓存层。

## 真正的工程瓶颈

## 1. 热点房间吞吐

单个 Durable Object 是单线程的，官方给出的软上限约为每对象 1000 requests/s。

这直接导出一个硬事实：

**单房间极限吞吐受单 DO 约束。**

而 Matrix 房间状态裁决又无法任意分片，因为是否能接纳新事件，依赖房间当前权威状态。也就是说：

* 用户级、媒体级、索引级可以横向扩展；
* 房间级主权不能随便拆成多个独立写者。

因此该方案的可扩展性是：

* **全站可横向扩展**
* **单房间不可无限扩展**

这与 Matrix 协议本身是相容的，但会形成热点房间天花板。

## 2. 单对象 10GB 存储上限

如果把一个超大房间的全部历史、状态快照、关系索引都长久留在单个 Room DO 的 SQLite 存储里，迟早会撞上 10GB 限制。

解决办法不是换库，而是分层：

* Room DO 只保留热状态、最近 timeline、auth frontier、必要索引；
* 历史事件按段归档到 R2；
* 可选把可搜索文本或聚合关系写入 D1；
* Room DO 中只保留指向冷段与快照的索引。

因此 10GB 不是 blocker，但它强迫你做冷热分层，不能偷懒。

## 3. 多次联邦读取与 6 连接限制

Workers 每次调用最多 6 个并发外连。

这会影响：

* 一次 join/backfill 里并行向多个远端拉事件；
* 大量媒体或远端 key 抓取；
* 多存储并行查询。

对策是：

* 把联邦回填做成异步阶段，而不是都塞进首个同步请求里；
* 由 `Remote Server DO` 负责排队与限流；
* Worker 前门只做必要最小同步工作。

这会增加延迟，但不构成协议不可实现。

## 4. 搜索与目录不是“顺手就有”

Matrix 的 `/search`、用户目录、public rooms、relations 聚合、通知计数，都要求持续维护衍生视图。

在 Cloudflare 上，这些功能不是靠某个“数据库自带”就能获得，而是必须明确构建：

* 事件进入房间主权层；
* 主权层发出索引任务；
* 索引层异步写 D1；
* `/search` 和目录接口查询 D1；
* 结果再按可见性做过滤。

这意味着实现量大，但不是平台 blocker。

## 性能与容量分析

## 1. `/sync` 是第一大流量与成本源

对 Matrix homeserver 来说，最容易低估的不是发消息，而是 `/sync`。

如果客户端使用典型的 30 秒 long-poll 超时，那么一个“持续在线”的设备每月大约会产生：

* `30 * 24 * 60 * 60 / 30 = 86,400` 次 `/sync` 请求

这会直接导出三个架构后果：

### A. Worker 持有 long-poll 是便宜的

Workers 对 HTTP 请求按 CPU 计费，而不是按 wall-clock 计费。  
这意味着：

* Worker 把 `/sync` 请求挂 30 秒本身不是问题；
* 只要 Worker 没有持续消耗 CPU，这段等待几乎不增加成本。

### B. 把 long-poll 停在 `UserDO` 里是错误的

Durable Objects 会对 active / non-hibernateable 的 wall-clock duration 计费。

如果把 `/sync` 的 30 秒等待直接停在 `UserDO` 内：

* 每个 `/sync` 大约会消耗 `30s * 128MB = 3.75 GB-s` 的 DO duration；
* 100 个持续在线设备，单月就会产生约 `32.4M GB-s`；
* 按官方价格估算，仅 DO duration 就约 `400 USD/月`；
* 1000 个持续在线设备时，这个数字大约是 `4045 USD/月`；
* 10000 个持续在线设备时，大约是 `40495 USD/月`。

因此，**不能让 `UserDO` 承担“等待客户端”的职责**。

### C. 正确模式应是“Worker 等待，DO 短探测”

推荐模型：

* Worker 持有客户端连接；
* `UserDO` 只负责返回用户增量版本号、设备队列状态、房间变化摘要；
* Worker 通过短探测判断是否有新数据，而不是把一个长请求卡在 `UserDO` 内。

这个模型的代价是 `UserDO` 请求数上升，但远远便宜于 DO duration。

按当前官方价格估算，一个持续在线设备每月的 `/sync` 基础成本大致是：

* Workers 请求费用：约 `0.026 USD / 设备 / 月`
* Workers CPU 费用（假设平均 1ms CPU / sync）：约 `0.0017 USD / 设备 / 月`
* `UserDO` 请求费用：
  * 若每个 `/sync` 只探测 1 次：约 `0.013 USD / 设备 / 月`
  * 若每个 `/sync` 在 30 秒里按 5 秒节拍探测 6 次：约 `0.078 USD / 设备 / 月`

这意味着：

* `/sync` 的**请求数**才是主要成本；
* 只要避免 DO-held long-poll，`/sync` 在 Cloudflare 上仍然是可支付的；
* 但当在线设备数进入 `10k-100k` 量级后，`/sync` 会成为账单主导项。

## 2. 写路径的性能瓶颈在 Room DO，而不是 Worker

对单房间写入，真正的上限来自 `RoomDO`：

* 每个 Durable Object 天然单线程；
* 官方给出单对象约 `1000 requests/s` 的软上限；
* Room DO 还要做事件鉴权、state resolution、持久化、联邦分发准备。

因此单房间真实吞吐通常会低于该软上限，尤其在以下场景：

* room state 很大；
* auth chain 很长；
* room version 规则复杂；
* 事件关系、聚合、线程、已读回执等派生数据同时更新；
* 入站联邦事件缺前序，需要补抓。

### 写放大决定热路径成本

如果一个事件在 `RoomDO` 的 SQLite 存储中平均写入：

* 事件主记录
* 前序边
* auth 边
* timeline 索引
* 当前状态索引
* membership/receipt/relations 等派生热索引

那么每个事件写入 `5-10` 行是完全可能的。

成本上可以近似理解为：

* `1000 万` 事件/月，若平均 `8` 行热写入/事件，则是 `8000 万` 行写入
  * DO SQL 写入费用约 `30 USD/月`
* `1 亿` 事件/月，若平均 `8` 行热写入/事件，则是 `8 亿` 行写入
  * DO SQL 写入费用约 `750 USD/月`
* `5 亿` 事件/月，若平均 `8` 行热写入/事件，则是 `40 亿` 行写入
  * DO SQL 写入费用约 `3950 USD/月`

结论很直接：

**热路径上最重要的优化目标不是“再省 1ms CPU”，而是压低每事件的行写放大。**

## 3. `/sync` fanout 不能只有一种策略

如果每条事件都在写入时 fanout 到每个本地用户邮箱，那么成本和吞吐都会随房间人数线性上升。

如果所有事情都推迟到 `/sync` 再按房间拉取，那么：

* 写路径很轻；
* 但 `/sync` 的读取和合并复杂度会明显升高。

因此更合理的模型是 **混合策略**：

* 小房间：偏 push-on-write  
  优点是 `/sync` 轻，缺点是写放大高。
* 大房间：偏 pull-on-read  
  优点是发送成本稳定，缺点是 `/sync` 合并复杂。

这不是“实现偏好”，而是容量规划问题。  
如果坚持单一策略，通常会在大房间或高在线数场景下付出明显代价。

## 4. 联邦路径的成本结构反而友好

Cloudflare 对这一类负载很有优势：

* Workers subrequests 不按“外呼请求数”单独收费；
* Workers / D1 / R2 没有额外 egress 费用；
* R2 对外下载也没有 Internet egress 费；
* `RemoteServerDO` 可以按远端服务器聚合事务，天然适合 Matrix federation。

这意味着：

* 大量联邦流量更可能吃掉的是 CPU 与对象请求，而不是带宽账单；
* 相比传统云上自建，Matrix 的媒体联邦与 backfill 在 Cloudflare 上的带宽经济性明显更好。

但有两个约束必须正视：

* 每个 Worker 调用最多 6 个并发外连；
* 一次 join / backfill 不适合在单请求里向很多远端并行抓取。

因此，大型 backfill 和缺事件修复应优先走：

* `RemoteServerDO` 排队
* Queues
* DO Alarms

而不是塞进同步请求。

## 5. 搜索性能取决于“写模型”而不是“查模型”

D1 的读成本非常低，真正危险的是写放大：

* 读：`$0.001 / 百万行`
* 写：`$1.00 / 百万行`

这意味着 `/search` 的主要成本风险来自“每条事件被索引成多少写行”，而不是用户搜了多少次。

粗略估算：

* 若搜索层每个事件只写 `1` 行文档记录
  * `1 亿` 事件/月 => D1 写入费用约 `50 USD/月`
* 若搜索层每个事件拆成 `20` 行倒排记录
  * `1 亿` 事件/月 => D1 写入费用约 `1950 USD/月`

因此，搜索设计必须满足两个目标：

1. 每事件索引写行数尽量低；
2. 不让一个全局 D1 库成为公共搜索热点。

在大型公开 homeserver 上，更稳妥的选择通常是：

* 搜索分片；
* 限制全局搜索；
* 对公开房间、私有房间、最近历史采用不同索引策略。

## 6. 媒体是容量问题，不是带宽账单问题

R2 对 Matrix 媒体非常友好：

* 存储 `0.015 USD / GB-month`
* Class A 写操作 `4.50 USD / 百万`
* Class B 读操作 `0.36 USD / 百万`
* Internet egress 免费

这会带来一个很反直觉的结论：

**在 Cloudflare 上，媒体通常不是最贵的部分。**

参考量级：

* `1TB` 媒体存储、`1000 万` 读、`100 万` 写
  * 约 `14.85 USD/月`
* `10TB` 媒体存储、`1 亿` 读、`1000 万` 写
  * 约 `222.75 USD/月`
* `50TB` 媒体存储、`5 亿` 读、`5000 万` 写
  * 约 `1146.75 USD/月`

因此在成本结构上：

* `/sync` 往往比媒体更贵；
* 搜索写放大往往比媒体更危险；
* R2 的价值在于把媒体从“带宽问题”变成“低成本对象存储问题”。

## 成本分析

## 1. 成本主次排序

对于一个规范级 Matrix homeserver，Cloudflare 上最可能的成本排序通常是：

1. `/sync` 请求量
2. `RoomDO` / `UserDO` 的请求数与热写入放大
3. 搜索索引写入
4. 日志与可观测性
5. 媒体存储与媒体读写
6. Workers CPU

这和很多传统部署的直觉不同。  
在 Cloudflare 上，**请求数和写放大通常比带宽更值得害怕**。

## 2. 三个参考成本档位

下面给出三个粗略估算场景。它们都假设：

* 使用 Workers Paid Plan
* `/sync` 平均 30 秒 long-poll
* Worker 持有 long-poll
* `UserDO` 只做短探测，不承担长等待
* `/sync` 平均 CPU 时间约 `1ms`
* `RoomDO` 热写放大约 `8` 行/事件
* 先不计搜索索引、WAF/Bot 管理、企业支持、人力成本

### 小型公开站点

假设：

* `1000` 个持续在线设备
* `1000 万` 事件/月
* `1TB` 媒体

粗略账单：

* 若每次 `/sync` 只探测 `1` 次 `UserDO`：约 `87 USD/月`
* 若按 `5s` 节拍探测、即每次 `/sync` 约 `6` 次 `UserDO`：约 `152 USD/月`

### 中型公开站点

假设：

* `10000` 个持续在线设备
* `1 亿` 事件/月
* `10TB` 媒体

粗略账单：

* `1` 次探测模式：约 `1380 USD/月`
* `6` 次探测模式：约 `2028 USD/月`

如果搜索设计写放大很高，这个场景的搜索层可能再额外增加数百到数千美元。

### 大型公开站点

假设：

* `50000` 个持续在线设备
* `5 亿` 事件/月
* `50TB` 媒体

粗略账单：

* `1` 次探测模式：约 `7128 USD/月`
* `6` 次探测模式：约 `10368 USD/月`

这个量级下，系统已经不是“能否上 Cloudflare”的问题，而是：

* `/sync` 延迟目标是多少；
* 是否允许大房间 pull-based sync；
* 搜索是否全量开启；
* 是否需要额外反滥用与日志采样。

## 3. 日志可能比你以为的贵

Workers Logs 在 Paid Plan 下：

* 每月包含 `2000 万` 条
* 超出后 `0.60 USD / 百万条`

因此：

* `1 亿` 条日志/月，额外费用约 `48 USD`
* `10 亿` 条日志/月，额外费用约 `588 USD`

对 Matrix 这种高请求量系统来说：

* 不能默认“每请求一条结构化日志”
* 必须做采样、按路由分级、错误优先
* `/sync`、健康检查、媒体 GET 都要尽量少打日志

## 3.5 一个具体小场景：20 用户、无联邦、1000 条消息/月、10GB 媒体

先给结论：

**这个规模下，账单几乎肯定仍然落在 Workers Paid Plan 的基础月费附近。**

如果不把 `/sync` long-poll 停在 `UserDO` 里，而且日志不过量，那么大致会是：

* **大概率：约 `5 USD/月`**
* **若 20 个设备 24x7 在线，且 `/sync` 采用短探测 `UserDO`：约 `5.1 - 6.5 USD/月`**

下面是拆解。

### 假设

为了估算，需要先固定几个假设：

* 20 个用户按 1 人 1 设备估算，即 `20` 个持续活跃设备上限
* 不开启 federation
* 每月内部聊天消息 `1000` 条
* 媒体存量 `10 GB`
* `/sync` 使用典型 `30s` long-poll
* Worker 持有 long-poll，不让 `UserDO` 长时间等待
* 不开启高成本的全量搜索索引
* 日志量保持克制

### Workers

若 `20` 个设备都保持 24x7 在线，每月 `/sync` 请求量大约为：

* `20 * 86,400 = 1,728,000` 次 `/sync` / 月

Workers Paid Plan 自带：

* `1000 万` 请求 / 月
* `3000 万` CPU ms / 月

因此在这个场景下：

* Workers 请求费用：`0`
* Workers CPU 费用：大概率 `0`

只要 `/sync` 平均 CPU 明显低于每次 `17ms` 左右，CPU 包含额度也足够，因为：

* `30,000,000 / 1,728,000 ≈ 17.36 ms/次`

而一个正常实现的 `/sync` 空轮询或小增量响应，通常不应接近这个数字。

### Durable Objects

这个场景的主要变量是 `UserDO` 被探测的频率。

若 20 个设备都 24x7 在线：

* 每个 `/sync` 只探测 `1` 次 `UserDO`
  * 月 DO 请求量约 `1.728M`
  * 扣除包含的 `1M` 请求后，超出 `0.728M`
  * 费用约 `0.11 USD/月`
* 若每个 `/sync` 在 30 秒里按 `5s` 节拍探测 `6` 次 `UserDO`
  * 月 DO 请求量约 `10.368M`
  * 扣除包含的 `1M` 请求后，超出 `9.368M`
  * 费用约 `1.41 USD/月`

消息写入本身几乎可以忽略：

* `1000` 条消息即便按 `8` 行热写入/消息估算，也只有 `8000` 行写入
* 相比 DO SQLite 每月包含的 `5000 万` 行写入，这基本可以视为 `0`

如果实现错误，把 `/sync` long-poll 停在 `UserDO` 里，那成本会完全变样；  
但在当前正确架构假设下，这个量级的 DO 成本非常小。

### D1

若不开启复杂搜索，或者只做极轻量索引：

* `1000` 条消息/月带来的 D1 读写几乎可以忽略
* Paid Plan 包含：
  * `250 亿` 行读 / 月
  * `5000 万` 行写 / 月
  * `5 GB` 存储

因此此场景里 D1 大概率也是：

* **`0 USD/月`**

### R2

R2 Standard 每月自带：

* `10 GB-month` 存储
* `100 万` Class A
* `1000 万` Class B

因此如果“媒体 10GB”指的是：

* 平均月存量大约 `10GB`
* 上传/读取次数不夸张

那么 R2 大概率也是：

* **`0 USD/月`**

只有当：

* 实际平均存储超过 `10GB-month`
* 或媒体读取次数远高于普通家庭/小团队聊天场景

才会开始产生小额额外费用。

### Logs

只要不对每个 `/sync` 都打详细日志：

* 20 用户这个规模通常也能落在 Workers Logs 的包含额度内

因此日志通常也不会显著增加费用。

### 汇总

在上述假设下，一个比较合理的月账单区间是：

* **低活跃 / 非 24x7 在线：约 `5 USD/月`**
* **20 设备都 24x7 在线，`/sync` 每次仅 1 次 DO 探测：约 `5.11 USD/月`**
* **20 设备都 24x7 在线，`/sync` 每次约 6 次 DO 探测：约 `6.41 USD/月`**

所以这个场景最准确的判断是：

**20 用户、无联邦、1000 条消息/月、10GB 媒体，在 Workers Paid Plan 上基本不会撞到任何主要计费阈值，账单极大概率就是基础月费 `5 USD` 左右。**

## 4. 哪些设计会显著抬高账单

以下设计会直接推高成本：

* 把 `/sync` long-poll 停在 `UserDO`
* 每事件都 fanout 到所有本地用户邮箱
* 搜索层按 token 生成大量索引写行
* 对每个请求都写完整日志
* 让 Room DO 长期维持 non-hibernateable 状态
* 过度依赖 KV 进行“伪实时”同步，最后又不得不反复回源校正

## 限制与运维风险

## 1. Workers Paid Plan 不等于更高上传体积

一个容易忽略的点是：

**请求体大小限制取决于 Cloudflare account plan，而不是 Workers plan。**

官方文档给出的入口请求体上限是：

* Free / Pro：`100 MB`
* Business：`200 MB`
* Enterprise：默认 `500 MB`

这对 Matrix 媒体接口很重要，因为：

* `m.upload.size` 必须如实反映入口上限；
* 如果只有 Workers Paid，但 zone 不是 Business / Enterprise，那么标准媒体上传能力可能仍然只有 `100 MB` 等级；
* 超大媒体若要支持，需要额外设计上传路径，而不能想当然地认为“R2 很大，所以入口也没问题”。

## 2. Durable Object 的限制决定主权边界

Paid Plan 下，SQLite-backed DO 的关键限制是：

* 单对象 `10 GB`
* 单对象天然单线程
* 单对象软上限约 `1000 requests/s`
* 单请求 CPU 默认 `30s`，可调到 `5 分钟`

对 Matrix 的含义是：

* Room DO 必须做冷热分层；
* 单房间吞吐永远存在上限；
* Room DO 内的算法和数据结构比“数据库选型”更重要。

## 3. D1 的限制决定它只能做索引层

D1 的关键限制是：

* 单数据库 `10 GB`
* 单数据库单线程
* 单查询最长 `30s`
* 如果并发队列堆满会返回 overloaded

因此：

* 不适合承接房间主权状态；
* 适合做可分片、可重建、读多写少的衍生索引；
* 在大型 homeserver 上应尽早规划分片，而不是等单库热点出现后再补救。

## 4. R2 的限制更多是接口约束，不是容量约束

R2 的关键限制是：

* 单对象最大约 `5 TiB`
* 单次上传最大约 `5 GiB`，更大要走 multipart
* 同一 object key 并发写约 `1/s`

这对 Matrix 的含义是：

* 媒体本体容量几乎不是问题；
* 真正需要关注的是入口上传限制和缩略图/转码策略；
* 对热点缩略图应缓存，而不是频繁重写同一 key。

## 5. 部署一致性是隐藏运维风险

Durable Objects 与 Workers 的代码更新是最终一致地在全球传播的。

这意味着在部署窗口里可能出现：

* 新 Worker 调到旧版本 DO
* 新旧 schema / RPC 契约短暂并存

因此必须：

* 做向后兼容的 RPC 版本化；
* schema 迁移采用双写或可回读策略；
* 不把“同时全球切换”当作可依赖语义。

## 推荐架构

## 入口层

一个或多个 Workers：

* `client-worker`
* `federation-worker`
* `well-known-worker`
* `media-worker`

职责：

* 鉴权；
* 路由；
* 限流；
* 签名验签；
* 请求规范化；
* 长轮询控制；
* 与 DO / D1 / R2 协调。

## 主权层

SQLite-backed Durable Objects：

* `RoomDO(room_id)`
* `UserDO(user_id)`
* `RemoteServerDO(server_name)`

职责：

* 串行裁决；
* 幂等；
* 事务边界；
* 当前状态维护；
* 重试与退避。

## 索引层

D1 分片：

* 用户目录；
* 搜索；
* public rooms；
* 通知汇总；
* 运营报表。

原则：

* 索引可重建；
* 索引失步不应破坏房间正确性；
* 不让 D1 决定房间是否接受某个事件。

## 对象层

R2：

* 媒体；
* 远端媒体缓存；
* 归档事件段；
* 房间快照；
* 批量导出。

## 缓存层

KV：

* `/.well-known` 缓存；
* 远端发现缓存；
* 远端签名键缓存副本；
* 低风险只读配置。

## 后台作业层

优先建议使用：

* Durable Object Alarms；
* Queues；
* 必要时 Workflows。

职责：

* 联邦重试；
* 回填缺失事件；
* 搜索索引；
* 缩略图生成；
* 清理与归档。

## 在本轮范围下的严格判断

### 结论

在 **Workers Paid Plan + homeserver only** 的范围里，结论是：

**可行，而且不是勉强可行，而是架构上有明确落点。**

真正决定成败的不是 Cloudflare 是否“能跑 Node 程序”，而是你是否接受如下架构事实：

* `Room DO` 是房间主权裁决者；
* `User DO` 是用户与设备主权裁决者；
* `RemoteServer DO` 是联邦传输主权裁决者；
* D1 只是索引；
* R2 负责大对象与冷历史；
* KV 只是缓存。

只要不违反这组边界，Workers Paid Plan 提供的 CPU、子请求配额、DO 存储能力、R2 强一致对象存储，以及无硬性 wall-time 的 HTTP 处理模型，都足以支撑一个规范级 homeserver。

### 当前范围内不再构成主 blocker 的点

* 入站 `8448` 不是 blocker，因为规范允许 `/.well-known` / SRV 委派；
* 大媒体与历史容量不是 blocker，因为 Paid Plan 下可用 R2 + DO 热冷分层；
* 大规模全站扩展不是 blocker，因为房间、用户、远端服务器都可横向拆成大量对象。

### 当前范围内仍然是硬工程约束的点

* 单房间吞吐上限；
* Room DO 的热状态体积控制；
* `/sync` 的增量 token 设计；
* 联邦缺事件回填与状态解析的正确性；
* 搜索与目录等衍生索引的异步一致性。

## 可行性评级

### 协议正确性

`B+`

原因：

* 房间/用户串行主权与 DO 高度匹配；
* 联邦异步传输也匹配；
* 真正难点在房间语义本身，而不是 Cloudflare。

### 平台适配度

`A-`

原因：

* Workers + DO + R2 的组合和 Matrix 的读写形态非常契合；
* D1/KV 只要不误用，问题不大；
* 入站 8448 不是 blocker，因为规范允许发现委派。

### 极限扩展性

`B`

原因：

* 全站可横向扩展；
* 单房间天花板明显；
* 索引层和冷数据层需要额外工程。

### 本轮目标可实现性

`A-`

原因：

* 平台原语与 homeserver 的正确分层高度匹配；
* 主要风险集中在协议实现复杂度，而非平台 blocker；
* 唯一明显的结构性上限来自单房间串行主权。

## 最终判断

最终判断在本轮范围里可以压缩成一句：

**在 Cloudflare Workers Paid Plan 上实现一个规范级 Matrix homeserver，是可行的；但它必须是一个以 Durable Objects 为一致性核心、以 R2 为媒体与归档层、以 D1 为衍生索引层的原生边缘架构，而不是把传统单体 homeserver 机械搬上 Workers。**

如果下一步要进入方案设计阶段，最应该先写的不是代码，而是三份形式化文档：

1. `RoomDO` 的状态机与 state resolution 规则；
2. `UserDO` 的 `/sync` 增量模型；
3. `RemoteServerDO` 的联邦事务与重试语义。

谁先把这三块定义清楚，谁就真正控制了这个系统的正确性。

## 主要来源

### Matrix 规范

* <https://spec.matrix.org/latest/>
* <https://spec.matrix.org/v1.17/client-server-api/>
* <https://spec.matrix.org/v1.17/server-server-api/>
* <https://spec.matrix.org/v1.17/application-service-api/>

### Cloudflare 官方文档

* <https://developers.cloudflare.com/workers/platform/limits/>
* <https://developers.cloudflare.com/durable-objects/platform/limits/>
* <https://developers.cloudflare.com/d1/platform/limits/>
* <https://developers.cloudflare.com/d1/best-practices/read-replication/>
* <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
* <https://developers.cloudflare.com/r2/reference/consistency/>
* <https://developers.cloudflare.com/workers/configuration/compatibility-flags/>
* <https://developers.cloudflare.com/fundamentals/reference/network-ports/>
