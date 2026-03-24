# Matrix Homeserver on Cloudflare: Initial Research

状态：Draft 0  
日期：2026-03-24  
范围：Matrix homeserver only, Cloudflare Workers Paid Plan

## 1. 研究目标

本文件是企业级 Spec 之前的初步研究备忘录。目标不是直接下实现细节，而是先回答下面几个根问题：

1. 一个完整 Matrix homeserver 在协议上到底由哪些能力域构成；
2. 这些能力域需要什么样的一致性、排序、存储和异步语义；
3. 在 Cloudflare 上，这些语义最自然的实现模型是什么；
4. 进入企业级 Spec 之前，哪些关键问题仍未被完全消除。

## 2. 顶层判断

在当前范围内，最重要的判断可以压缩成一句：

**Matrix homeserver 的正确性核心不是“数据库能不能扩展”，而是“每个房间、每个用户、每个远端服务器是否存在清晰的主权状态机”。**

这直接把 Cloudflare 上的建模方向限定为：

* Worker 负责接入、聚合、长连接、边缘路由；
* Durable Object 负责主权状态；
* R2 负责大对象与冷历史；
* D1 负责衍生索引；
* KV 只做低风险缓存；
* Queues / DO Alarms 负责异步重试与后台任务。

换句话说，**正确的目标不是把传统单体 homeserver 迁移到 Workers，而是设计一个原生边缘版的 homeserver。**

## 3. 必须实现的协议域

根据当前 Matrix `v1.17` 资料，一个完整 homeserver 在本轮范围内至少需要覆盖以下协议域。

## 3.1 Identity / Session / Device Domain

能力包括：

* 登录、注册、刷新令牌、登出；
* 设备列表管理；
* token / session 生命周期；
* account data；
* 用户 profile。

为什么重要：

* 这是所有 client-server 鉴权与个性化视图的根。
* 也是 E2EE 设备图、`/sync` 和 to-device 投递的锚点。

一致性需求：

* 按用户线性化即可，不需要全局线性化。

初步结论：

* 这天然适合 `UserDO(user_id)`。

## 3.2 Room Domain

能力包括：

* 建房、加入、邀请、离开、踢出、封禁；
* 发送 timeline event；
* 写 state event；
* redaction；
* room directory / alias；
* room summary；
* room history 读取与分页。

为什么重要：

* 这是 homeserver 最复杂的域。
* 新事件能否接受，取决于房间状态、auth chain、room version 规则、冲突 state 的解析结果。

一致性需求：

* 每个房间必须有确定的主权裁决顺序；
* 对单房间而言，本质上是严格串行进入状态机。

初步结论：

* 这天然适合 `RoomDO(room_id)`；
* 不能把“房间当前状态”的主真相放进 D1 或 KV。

## 3.3 Sync / Notification Domain

能力包括：

* `/_matrix/client/v3/sync`
* unread counts
* ephemeral events
* room account data
* global account data
* to-device
* device_lists
* presence

为什么重要：

* `sync` 不是一个查询接口，而是“按设备视角生成的增量流”。
* 对成本、吞吐和用户体验的影响往往超过消息发送本身。

一致性需求：

* token 必须单调；
* 单设备视图必须可重放；
* 不能向客户端返回内部矛盾的增量快照。

初步结论：

* `sync` 的等待必须由 Worker 持有；
* `UserDO` 只负责增量版本与用户主权状态；
* 这会成为企业级 Spec 中单独一章。

## 3.4 E2EE Transport Domain

能力包括：

* `/keys/upload`
* `/keys/query`
* `/keys/claim`
* cross-signing related uploads
* room key backup metadata and blobs

为什么重要：

* homeserver 不解密 Megolm/Olm 内容，但要可靠存储、转发和计数设备密钥材料。
* device graph 与 `/sync` 强耦合。

一致性需求：

* 按用户/设备线性化；
* 对 one-time keys 的消费与计数必须正确。

初步结论：

* 以 `UserDO` 为主；
* 备份大对象可以落到 R2；
* 设备图的衍生索引可进 D1。

## 3.5 Media Domain

能力包括：

* 媒体上传、下载、缩略图；
* 远端媒体缓存；
* 内容类型、文件名与元数据；
* 上传上限声明。

为什么重要：

* 媒体不是主权状态，但体量最大；
* 与入口请求体上限、对象存储、缩略图处理强相关。

一致性需求：

* 读写对象级一致即可；
* 不需要像 room state 那样的复杂全序。

初步结论：

* 媒体本体落 R2；
* 元数据与上传会话可以由 DO 协调；
* Worker 入口必须服从 Cloudflare account plan 的请求体上限。

## 3.6 Federation Domain

能力包括：

* 服务器发现；
* 签名、公钥发布与远端公钥获取；
* PDU / EDU 入站；
* 出站事务 `/_matrix/federation/v1/send/{txnId}`；
* make/send join/leave/invite；
* backfill / event / state / state_ids；
* 缺事件修复与重试。

为什么重要：

* 这是 homeserver 成为“Matrix homeserver”而非“本地聊天服务器”的关键区别。

一致性需求：

* 对单个远端服务器的事务发送与去重需要确定性；
* 对单房间入站事件裁决仍然要回到 `RoomDO`。

初步结论：

* `RemoteServerDO(server_name)` 是最自然的联邦出站主权单元；
* 入站 federation Worker 验签后再把业务语义分发给 `RoomDO` / `UserDO`。

## 3.7 Application Service Domain

能力包括：

* HS -> AS transactions；
* user / alias / room namespace query；
* ping；
* third-party protocol lookup。

为什么重要：

* 对企业级 homeserver 来说，桥接和集成能力很重要；
* 但它不应污染房间主权模型。

一致性需求：

* transaction 幂等；
* namespace 校验正确；
* 回推顺序可控。

初步结论：

* 可由独立的 AS integration layer 承接；
* 但最终落点仍然是房间域与用户域。

## 4. Matrix 协议语义对实现模型的硬要求

## 4.1 房间是 DAG，不是 append-only log

这一点决定了：

* “单表写消息”模型不够；
* 必须显式维护前序、auth、state 与冲突解析边界；
* room version 是运行时语义的一部分，不只是 schema 字段。

## 4.2 Room version 不是附属特性，而是核心行为开关

当前 `v1.17` room version 总览明确指出：

* room 版本没有隐含排序层级；
* 服务器对不同 room version 要遵守不同的算法与规则集；
* 当前建议默认使用 **room version 12** 创建新房间。

这意味着企业级 Spec 至少必须回答：

* 首发实现支持哪些 stable room versions；
* 内部实现是做“版本分发表”还是“共享内核 + 版本策略对象”；
* 如何保证新 room version 加入时不破坏旧房间。

## 4.3 `sync` 是产品表面的 API，实则是内部流系统

只要系统允许多个设备在线，`sync` 就会成为：

* 请求量最高的路由之一；
* 用户体感最敏感的路由；
* 成本结构最容易失控的路由。

因此企业级 Spec 不能把 `sync` 放在“查询接口”一章里草草带过，而要单列：

* token 模型；
* 用户增量流；
* 房间增量投影；
* `sync` 聚合器；
* 降级策略与限流策略。

## 4.4 联邦的核心不是 HTTP，而是异步恢复能力

真正困难的不是会不会调用 `/send/{txnId}`，而是：

* 对端不稳定时如何退避；
* 缺前序事件时如何恢复；
* 出站和入站如何保持幂等；
* 部分 join / backfill 失败时如何保持本地状态机健康。

因此联邦实现本质上是：

* 一个“有签名、有队列、有重试、有回填”的分布式恢复系统。

## 5. Cloudflare 原语的初步映射

## 5.1 Worker 是 front door，不是主权层

Worker 应负责：

* HTTP 路由；
* 鉴权；
* 限流；
* `/.well-known`；
* 长轮询连接持有；
* 前后端协议转换；
* 调度到 DO / D1 / R2。

Worker 不应负责：

* 房间裁决；
* 用户主权状态；
* 联邦事务持久主真相。

## 5.2 Durable Object 是主权状态机容器

Cloudflare 官方资料给出的几个关键事实非常适合 Matrix：

* 每个对象天然单线程；
* SQLite-backed DO 提供强一致、事务性、本地 SQL；
* 每对象 10GB；
* 每对象软上限约 1000 req/s；
* 生命周期允许 hibernation，但 non-hibernateable duration 会收费。

这几条几乎直接定义了建模：

* `RoomDO(room_id)`  
  负责 room state、timeline 热层、auth frontier、入站事件裁决。
* `UserDO(user_id)`  
  负责设备、token、to-device、account data、presence 聚合、sync cursor。
* `RemoteServerDO(server_name)`  
  负责联邦出站队列、事务去重、重试与回填调度。

## 5.3 D1 是索引层，不是裁决层

官方资料中 D1 的关键信号是：

* 单库 10GB；
* 单库单线程；
* 读复制是异步的；
* 使用 Sessions API 才能保证顺序一致读。

这说明：

* D1 适合查询；
* D1 不适合房间当前状态裁决；
* D1 可以承接搜索、目录、统计、后台分析等衍生视图。

## 5.4 R2 是媒体和冷历史层

R2 的关键信号是：

* 强一致；
* 大对象能力强；
* Internet egress 免费；
* 单对象上传与 multipart 规则明确。

这使 R2 成为：

* 媒体仓库；
* 缩略图存储；
* 远端媒体缓存；
* 房间冷历史段；
* 快照与导出归档。

## 5.5 KV 只应出现在缓存层

KV 的关键事实是：

* 最终一致；
* 全球可见可能有明显延迟；
* 不适合原子读写事务。

因此它只能放在：

* `/.well-known` 缓存；
* server discovery cache；
* remote key cache；
* 低风险能力缓存。

## 5.6 Queues / DO Alarms 是后台恢复面

对于 Matrix 来说，后台面至少包括：

* federation retry；
* backfill；
* 搜索索引；
* 媒体缩略图；
* 归档与清理。

初步建议是：

* 短周期、对象局部的定时工作用 DO Alarm；
* 大批量异步消费、解耦与重试用 Queues；
* 在进入正式 Spec 前，再决定是否需要更高层工作流抽象。

## 6. 初步实现模型

## 6.1 Bounded Contexts

企业级 Spec 当前可以先按以下 bounded context 拆分：

1. Identity & Devices
2. Rooms & State Resolution
3. Sync & Notifications
4. E2EE Key Transport
5. Media Repository
6. Federation
7. Application Services
8. Search & Directory
9. Operations & Control Plane

这个划分的优点是：

* 与协议面基本对齐；
* 与 Cloudflare 存储模型也对齐；
* 便于后续把负责人、测试策略和上线范围拆开。

## 6.2 运行时拓扑

初步运行时拓扑建议：

* `client-worker`
* `federation-worker`
* `media-worker`
* `well-known-worker`
* 可选 `admin-worker`

后端状态层：

* `RoomDO`
* `UserDO`
* `RemoteServerDO`

存储层：

* R2: media + archives
* D1: search + directory + analytics-friendly indexes
* KV: cache only

异步层：

* Queues
* DO Alarms

## 6.3 数据热冷分层

这是当前研究中最明确的结构性要求之一。

### 热层

必须留在 DO：

* 房间当前状态；
* 房间最近 timeline；
* auth frontier；
* device graph；
* sync 游标；
* 联邦事务与退避状态。

### 温层

适合 D1：

* 用户目录；
* public rooms；
* 搜索索引；
* 报表视图；
* 审计与后台查询。

### 冷层

适合 R2：

* 历史事件段；
* 快照；
* 媒体；
* 远端媒体；
* 备份与导出。

## 7. 当前最值得继续深入的高风险问题

以下问题在进入完整 Spec 前应优先深化。

## 7.1 `sync` token 模型

待回答：

* token 是用户级、设备级，还是复合 token；
* token 是否需要携带每个 room shard 的进度；
* 如何在不让 `UserDO` 长时间等待的前提下做到低延迟；
* 如何处理 limited timeline、lazy-loading、device_lists 和 to-device 的组合。

这是当前最重要的研究主题之一。

## 7.2 房间事件存储布局

待回答：

* `RoomDO` 中最小必需热数据有哪些；
* 哪些关系必须热存，哪些可以归档；
* 如何为 state resolution 保留足够信息，同时不让单对象 10GB 过早耗尽；
* 是否要按段把老 timeline 外溢到 R2。

## 7.3 Room version 兼容策略

待回答：

* 首发支持最小集合是什么；
* 是否必须对所有 stable room versions 提供读兼容；
* 如何把授权规则、redaction 规则、join rules 与 event format 差异抽象成可测试策略。

## 7.4 联邦恢复语义

待回答：

* 缺事件时是同步补抓还是异步修复；
* `RemoteServerDO` 与 `RoomDO` 的责任边界在哪里；
* server discovery / key fetch / send retry 的缓存与失效模型怎么设计；
* 如何在部分失败下维持本地房间健康。

## 7.5 搜索范围

待回答：

* 首发是否支持全文搜索；
* 搜索是否默认只针对本地可见房间；
* 每条消息允许多少索引写放大；
* 是否需要分片；
* 是否区分公开房间和私有房间索引策略。

## 8. 初步非功能需求方向

企业级 Spec 至少需要覆盖这些非功能方向：

* Correctness first: 房间裁决和 sync 一致性优先于局部低延迟；
* Cost transparency: `/sync`、DO 请求、索引写放大必须可观测；
* Gradual deployability: Worker 与 DO 代码版本必须支持平滑迁移；
* Recoverability: backfill、federation retry、reindex 必须可重跑；
* Operability: 每个 bounded context 都要有独立指标；
* Abuse resistance: 注册、媒体、搜索、presence、typing 都要有速率与资源防护。

## 9. 初步结论

到目前为止，最重要的研究结论有六条：

1. Matrix homeserver 的关键主权边界是 room、user、remote server 三类状态机。
2. Cloudflare 上最自然的主权容器是 SQLite-backed Durable Objects。
3. D1 只适合索引与查询，不适合房间裁决。
4. R2 使媒体与冷历史天然具备低成本承载面。
5. `sync` 必须是单独设计的流系统，而不是顺手拼装的查询接口。
6. 企业级 Spec 的真正难点不是“接口列全”，而是“状态机、数据布局、迁移与恢复语义”写清楚。

## 10. 下一步建议

在进入完整 Spec 正文之前，下一轮研究应按以下顺序展开：

1. `Sync Domain Research`
   - token 模型
   - 用户增量流
   - Worker-held long-poll
2. `Room Domain Research`
   - 事件图、state resolution、room version 抽象
   - RoomDO 热数据布局
3. `Federation Domain Research`
   - RemoteServerDO 事务模型
   - 缺事件修复与退避
4. `Media + Search Domain Research`
   - 上传/下载路径
   - 索引写放大与分片策略
5. `Enterprise NFR Research`
   - 部署、迁移、可观测性、安全模型

完成这五块后，企业级 Spec 才能进入“正文写作”而不是“继续摸边界”的阶段。
