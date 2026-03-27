# TODO.md

## Purpose

本文件是从当前 `spec/framework/` 派生出的**开发执行清单**。

规则固定如下：

* `spec/framework/` 是行为真相。
* 本文件是按依赖顺序展开的执行计划。
* 当 `TODO.md` 与 Spec 冲突时，以 Spec 为准，并在同一变更中修正本文件。
* 默认按顺序执行，除非某条明确标注“可并行”。
* 任何代码任务如果前置 Spec、契约、数据契约、流程图、测试门禁未闭合，必须先补 Spec，不得跳过。

## Status Legend

* `[ ]` 未开始
* `[~]` 进行中
* `[x]` 完成

## Global Completion Rule

任一任务只有在以下条件同时满足时才可打勾：

* 产出物已落盘
* 对应 Spec 引用可回链
* 对应测试已存在或同步补齐
* 不破坏更前面的完成项
* 若发现 Spec 缺口，已补 `Spec` / `DEC-*` / `OQ-*`

## Suggested Codebase Layout

首轮实现建议按运行时边界组织仓库：

* `apps/gateway-worker/`
* `apps/jobs-worker/`
* `apps/ops-worker/`
* `packages/runtime-core/`
* `packages/contracts/`
* `packages/spec-tools/`
* `packages/testing/`
* `tests/local/`
* `tests/integration/`
* `tests/staging/`
* `ops/`

说明：

* 目录结构不是规范真相，但必须服从 `21-runtime-topology-and-platform-model.md` 的边界。
* 若实际落地结构不同，必须仍能清晰映射到 `gateway-worker`、`jobs-worker`、`ops-worker`、`UserDO`、`RoomDO`、`RemoteServerDO`。

## Phase 00: Governance And Traceability Bootstrap

目标：先把“文档即真相”的机器化基线立住，再开始业务实现。

### 00.01 建立基础工程和脚本入口

- [x] 建立最小可运行的工程骨架与统一脚本入口。
  Spec refs: `10`,`11`,`14`,`21`,`42`
  产出:
  `package.json` 或等价任务入口、基础目录结构、统一 `dev/test/lint/build` 占位脚本。
  完成标准:
  仓库内后续 Worker、DO、测试、治理工具都有明确放置位置。

### 00.02 实现 Spec 解析与 ID 扫描工具

- [x] 编写 `packages/spec-tools/`，扫描 `spec/framework/`、`spec/decisions/`、`spec/open-questions/` 中的 canonical IDs。
  Spec refs: `11`,`14`,`43`,`44`
  产出:
  ID 扫描器、canonical ID 校验器、引用提取器。
  完成标准:
  能稳定抽取 `REQ/MX/CF/IF/DATA/FLOW/STATE/TEST/EVID/DEC/OQ`。

### 00.03 实现 `requirement-register` 生成器

- [x] 从 owning spec 中的 `REQ` 表行生成 machine-readable requirement register。
  Spec refs: `14` 3.1.1, `43` `TEST-GOV-001`, `44` `EVID-GOV-001`
  产出:
  `requirement-register.csv`、`requirement-register.json` 生成器。
  完成标准:
  能输出 `req_id`,`owning_spec`,`title`,`normative_statement`,`source_file`,`source_line`,`status`。

### 00.04 实现 `traceability-matrix` 生成器

- [x] 从 Spec 中生成双向 traceability matrix。
  Spec refs: `14` 7.1-7.2, `43` `TEST-GOV-001`, `44` `EVID-GOV-001`
  产出:
  `traceability-matrix.csv`、`traceability-matrix.json` 生成器。
  完成标准:
  能校验断链、缺失反向边、未登记引用、重复 `REQ-ID`。

### 00.05 实现 wildcard route family 展开器

- [x] 实现 `/_matrix/.../*/...` route family 的 pinned `v1.17` 显式展开与审计快照。
  Spec refs: `23` 2, 2.1, `43` 6, `44` 2.3
  产出:
  wildcard route expansion 工具和审计产物。
  完成标准:
  测试与治理工具不再直接拿 `*` 当最终路由集合。

### 00.06 完成 `TEST-GOV-001` / `EVID-GOV-001`

- [x] 建立治理 CI 门禁并能落证据。
  Spec refs: `43` `TEST-GOV-001`, `44` `EVID-GOV-001`, `evidence/common/EVID-GOV-001/README.md`
  产出:
  生成 `summary.md`、requirement register、traceability matrix、wildcard expansion 审计快照。
  完成标准:
  每次提交都可运行治理检查，并能在 `evidence/common/EVID-GOV-001/` 下产出规范工件。

## Phase 01: Runtime Skeleton And Shared Foundations

目标：把 Spec 中固定的运行时边界、共享算法和错误模型先落成真正的代码骨架。

### 01.01 建立三个 Worker 与三个主权 DO 的代码骨架

- [x] 建立 `gateway-worker`、`jobs-worker`、`ops-worker`、`UserDO`、`RoomDO`、`RemoteServerDO` 基础工程。
  Spec refs: `20`,`21`
  产出:
  Worker 入口、DO class 占位、Service Binding / Queue / storage 绑定声明。
  完成标准:
  代码结构与运行时边界一一对应。

### 01.02 固定环境配置与 secrets 装载模型

- [x] 建立显式环境变量、secret、feature gate、compatibility date 管理层。
  Spec refs: `10` `REQ-GOV-004`, `13` `CF-WKR-013`~`CF-WKR-022`, `40` 5
  产出:
  配置加载模块、环境 schema、secret 访问封装。
  完成标准:
  无业务代码直接读取散乱环境变量或 secret 名称。

### 01.03 建立共享错误模型与 wire schema 类型

- [x] 为 `MatrixUnrecognizedErrorBody`、`MatrixUnknownTokenErrorBody`、`OpsErrorResponse`、`InternalErrorEnvelope` 建立共享类型与序列化逻辑。
  Spec refs: `26` 4
  产出:
  `packages/contracts/` 中的错误体类型、编码器、解码器。
  完成标准:
  stub route、认证失败、控制面错误都复用同一实现。

### 01.04 实现 canonicalization 与 request fingerprint

- [x] 实现 RFC 8785 JCS canonicalization、`request_fingerprint`、`canonical_filter_hash`。
  Spec refs: `22` 4.1-4.3
  产出:
  共享 canonicalization 库与哈希工具。
  完成标准:
  客户端幂等、控制面幂等、filter 规范化可复用同一实现。

### 01.05 实现 correlation ID / structured log 基础设施

- [x] 建立 `request_id`、`causation_id`、`job_id`、`txn_id` 的关联模型和结构化日志输出。
  Spec refs: `41` 2-5
  产出:
  统一 logger、中间件、日志字段 schema。
  完成标准:
  所有后续 Worker/DO 路径都可直接接入统一日志与相关性 ID。

### 01.06 建立基础测试框架

- [x] 建立 local / CI integration / staging / pre-release 的测试目录与测试运行入口。
  Spec refs: `43` 2, 5
  产出:
  测试目录、测试 bootstrap、环境选择逻辑。
  完成标准:
  后续 `TEST-*` 能按环境分层接入，而不是混成一套。

## Phase 02: Control Plane And Recovery Substrate

目标：先把安全的控制面、作业框架、审计与恢复底座做出来，因为它既服务后续开发，也服务验证和灾备。

### 02.01 实现 `ops-worker` 认证与授权

- [ ] 实现 `Cf-Access-Jwt-Assertion` 验证、JWK 刷新、`principal_id` 映射、scope 判定。
  Spec refs: `40` 3.3, 3.3.1, 3.3.2; `24` `DATA-D1-006`; `26` 5; `13` `CF-NET-004`~`CF-NET-006`
  产出:
  Access JWT 验证器、operator authz middleware、`DATA-D1-006` 访问层。
  完成标准:
  控制面只信任 Access JWT，不直接信任 service token headers 或 cookie。

### 02.02 实现 `DATA-OPS-004` 审计与控制面幂等

- [ ] 建立 `audit_event` + `request_dedupe_projection`。
  Spec refs: `24` 8, 8.1; `40` 8.2, 8.3; `26` 5
  产出:
  D1 schema、写入事务、重复请求折叠逻辑。
  完成标准:
  所有控制面写请求都能“先审计、后副作用”。

### 02.03 实现 `IF-OPS-001`~`IF-OPS-008`

- [ ] 完成 healthz/readyz、jobs create/query/cancel、appservice config 控制面接口。
  Spec refs: `23` 3.8, `26` 5, `42` 12
  产出:
  `ops-worker` HTTP handlers、payload 验证、错误模型。
  完成标准:
  控制面不需要临时脚本即可启动 export/rebuild/repair/restore/appservice 管理。

### 02.04 实现 `DATA-OPS-010` / `DATA-OPS-011` shard registry

- [ ] 建立 shard registry、registry snapshot、post-commit success barrier 语义。
  Spec refs: `24` 8, 8.2; `42` 11.2.0
  产出:
  D1 schema、upsert 规则、snapshot 生成逻辑。
  完成标准:
  新 shard 的创建、注册、快照冻结都有确定实现路径。

### 02.05 实现 control-plane job state 与 payload

- [ ] 落地 `JobHandle`、`JobSummary`、`ExportJobSpec`、`RestoreJobSpec`、`RebuildJobSpec`、`RepairJobSpec` 等 payload。
  Spec refs: `26` 5.1-6.4, `42` 10-12
  产出:
  控制面 payload 类型、作业状态存储、状态机实现。
  完成标准:
  `STATE-REBUILD-JOB`、`STATE-EXPORT-JOB`、`STATE-RESTORE-JOB`、`STATE-REPAIR-JOB` 有代码落位。

### 02.06 建立 `jobs-worker` 作业框架与 Queue consumer

- [ ] 建立统一 job dispatcher、queue consumer、checkpoint 机制。
  Spec refs: `21` 6, `23` 4.2, `26` 6.5, `42` 10
  产出:
  `jobs-worker` 作业总线、queue handlers、job checkpoint 存储。
  完成标准:
  任一重建/导出/修复作业都可断点续跑。

### 02.07 实现导出/恢复 manifest 编码

- [ ] 落地 checkpoint manifest、bundle manifest、registry snapshot、R2 object key 规则。
  Spec refs: `24` `DATA-R2-005`, `24` 8.3, `42` 11.2.1~11.2.4, `26` 6.4-6.5
  产出:
  manifest types、hash/signature、R2 object key builder、completeness state。
  完成标准:
  后续 DR、restore、repair 都建立在统一 manifest 上，而不是临时 JSON。

## Phase 03: Core Data Plane Storage And Schemas

目标：把所有主权面和派生面的基础 schema 一次性按 Spec 钉住。

### 03.01 落地 `UserDO` schema

- [ ] 建立 `DATA-USER-001`~`DATA-USER-017`。
  Spec refs: `24` 3, `30`
  产出:
  `UserDO` SQLite schema、schema_version、访问层。
  完成标准:
  session/device/key/account_data/profile/push_rules/pending_upload/to-device/dedupe 都有权威存储。

### 03.02 落地 `RoomDO` schema

- [ ] 建立 `DATA-ROOM-001`~`DATA-ROOM-012`。
  Spec refs: `24` 4, `31`
  产出:
  `RoomDO` SQLite schema、查询索引、fanout outbox、客户端幂等表。
  完成标准:
  房间事件元数据、快照、membership、ephemeral、fanout、idempotency 全部可持久化。

### 03.03 落地 `RemoteServerDO` schema

- [ ] 建立 `DATA-FED-001`~`DATA-FED-006`。
  Spec refs: `24` 5, `32`
  产出:
  `RemoteServerDO` SQLite schema、两阶段入站 txn 去重与结果缓存。
  完成标准:
  出站队列、退避、入站去重、gap repair backlog 都有主权存储。

### 03.04 落地 D1 派生面与控制面 schema

- [ ] 建立 `DATA-D1-001`~`DATA-D1-006`。
  Spec refs: `24` 6, `34`, `40`, `42`
  产出:
  search index、user directory、public rooms、media catalog、appservice config、operator authz policy 表。
  完成标准:
  D1 上只有派生面和控制面权威元数据，没有数据面权威真相。

### 03.05 落地 R2 / KV keyspace

- [ ] 建立 `DATA-R2-001`~`DATA-R2-006`、`DATA-KV-001`~`DATA-KV-002` 的对象键空间和 metadata 规则。
  Spec refs: `24` 7, `33`, `42`
  产出:
  key builders、metadata schema、读写封装。
  完成标准:
  本地媒体、远端媒体缓存、缩略图、房间冷归档、导出对象、backup segment 都可按固定模式落盘。

## Phase 04: Discovery, Session, Identity, UIA, And Stub Guards

目标：先完成 L1 入口层和所有必须 deterministic 的 disabled truth。

### 04.01 实现公开 discovery 面

- [ ] 实现 `IF-PUB-001`,`IF-PUB-002`,`IF-CS-001`,`IF-CS-002`,`IF-CS-005`,`IF-CS-009`。
  Spec refs: `23` 3.1, `30` 4-5, `32` 3, `25` `FLOW-CS-DISCOVERY`,`FLOW-FED-METADATA-SERVE`
  产出:
  `/.well-known`、`/versions`、`/capabilities`、`/login`、`/register/available` handlers。
  完成标准:
  discoverability truth 与当前启用能力完全一致。

### 04.02 实现 Access/Refresh token 真相与 session 解析

- [ ] 实现 `DATA-ID-003`,`DATA-ID-004`,`IF-INT-USER-001`,`STATE-USER-SESSION`。
  Spec refs: `24` 2, `30` 3, `40` 2-3
  产出:
  session parser、token hash 校验、session lifecycle。
  完成标准:
  所有认证态请求都只能经 `UserDO` 判定 session 有效性。

### 04.03 实现注册 / 登录 / 刷新 / 注销 / whoami

- [ ] 完成 `IF-CS-010`~`IF-CS-014`。
  Spec refs: `30` 4.2, 4.3, 4.6, 4.7; `25` `FLOW-CS-REGISTER`,`FLOW-CS-LOGIN`,`FLOW-CS-REFRESH`
  产出:
  对应 handlers、`UserDO` command path、幂等与错误模型。
  完成标准:
  无半创建、无半 session、refresh 重放可判失效。

### 04.04 实现共享 UIA 模型、密码变更、账户停用

- [ ] 完成 `DATA-ID-006`,`IF-CS-006`,`IF-CS-008`,`STATE-UIA-SESSION`。
  Spec refs: `30` 4.1, 4.4, 4.5; `26` 6.2; `40` 3.1
  产出:
  route-bound UIA token、password change、deactivate command path。
  完成标准:
  UIA token 不可跨路由/跨主体重放，`auth_version` 推进正确。

### 04.05 实现 deterministic stub / unsupported route guards

- [ ] 实现 `IF-CS-007`,`IF-CS-053`~`IF-CS-065` 与对应 discoverability 收口。
  Spec refs: `12` stub-only 条目, `23` 3.6, `25` `FLOW-CS-DISABLED-ROUTE`
  产出:
  固定 `404 M_UNRECOGNIZED` / `401 M_UNKNOWN_TOKEN` guards、短路中间件。
  完成标准:
  stub route 在 access token、UIA、provider callout、业务 dispatch 之前短路。

## Phase 05: Profile, Account Data, Push Rules, To-Device, Presence, Sync

目标：完成用户域的真正 L1 使用面。

### 05.01 实现 profile truth 与传播

- [ ] 实现 `IF-CS-017`,`DATA-USER-012`,`FLOW-CS-PROFILE-PROPAGATION`。
  Spec refs: `30` 5.2, `24` `DATA-USER-012`, `25` `FLOW-CS-PROFILE-PROPAGATION`
  产出:
  profile GET/PUT/DELETE、`displayname/avatar_url` 传播、`profile_version` 去重。
  完成标准:
  `m.tz` 与 custom field 语义也被正确支持。

### 05.02 实现 account data / tags / read markers

- [ ] 实现 `IF-CS-015`,`DATA-USER-006`,`DATA-USER-007`。
  Spec refs: `30` 5.3, `24` `DATA-USER-006`,`DATA-USER-007`
  产出:
  global/room account data、tags、read markers handlers。
  完成标准:
  所有变更进入 `user_stream`。

### 05.03 实现 push rules 与 notification state

- [ ] 实现 `IF-CS-018`,`DATA-USER-013`，并接入 `push rules` 基线。
  Spec refs: `30` 5.4, `43` 6
  产出:
  push rule CRUD、顺序调整、enabled 状态、默认规则基线装载。
  完成标准:
  运行时默认规则可与 `v1.17` 基线逐条比对。

### 05.04 实现 to-device 与幂等裁决

- [ ] 实现 `IF-CS-041`,`IF-INT-USER-005`,`DATA-USER-008`,`DATA-USER-016`。
  Spec refs: `30` 5.5, `24` `DATA-USER-008`,`DATA-USER-016`, `25` `FLOW-CS-SEND-TO-DEVICE`
  产出:
  public handler、local enqueue、dedupe registry、设备消费。
  完成标准:
  同一 public txn key 重试不会重复入队。

### 05.05 实现 presence

- [ ] 实现 `IF-CS-016`,`DATA-USER-009`。
  Spec refs: `30` 5.6
  产出:
  presence 读写、presence 版本推进、进入 `user_stream`。
  完成标准:
  presence 当前值不与 profile/account data 混用。

### 05.06 实现 filters、sync token、user stream

- [ ] 实现 `IF-CS-003`,`IF-CS-004`,`DATA-ID-001`,`DATA-USER-010`,`IF-INT-USER-002`。
  Spec refs: `30` 5.1, 7, 8, 9; `22` 4
  产出:
  stored filter、inline filter 规范化、`next_batch` 编码、collectSince。
  完成标准:
  token 对客户端 opaque，内部至少编码版本与 `user_stream_pos`。

### 05.07 实现 Worker-held `/sync`

- [ ] 完成 `IF-CS-020`,`STATE-SYNC-WAITER`,`FLOW-CS-SYNC-LONGPOLL`。
  Spec refs: `30` 8-10, `25` `FLOW-CS-SYNC-LONGPOLL`,`STATE-SYNC-WAITER`, `13` `CF-WKR-001`
  产出:
  long-poll handler、single waiter 规则、wake channel、assemble path。
  完成标准:
  早返回不会推进 token，deploy 中断视为正常重试路径。

## Phase 06: Room Core, Room Versions, And Local Fanout

目标：完成 L1 的房间正确性核心。

### 06.01 实现统一事件接纳流水线

- [ ] 实现 `IF-INT-ROOM-001`,`FLOW-ROOM-EVENT-ADMISSION`,`STATE-ROOM-EVENT-ADMISSION`。
  Spec refs: `31` 3-5, `25` 对应 flow/state
  产出:
  event validation、auth checks、state resolution、commit path。
  完成标准:
  本地客户端写入、联邦写入、AS 写入都走同一准入管道。

### 06.02 实现房间创建与 membership 变更

- [ ] 实现 `IF-CS-030`,`IF-CS-031`,`FLOW-CS-ROOM-MEMBERSHIP`,`STATE-ROOM-MEMBERSHIP`。
  Spec refs: `31` 4, 6, 11, 12
  产出:
  create/join/invite/leave/ban/unban/kick/knock/forget。
  完成标准:
  membership 当前视图与房间提交原子同步。

### 06.03 实现消息发送 / 状态事件 / redaction

- [ ] 实现 `IF-CS-032`,`IF-CS-033`,`IF-CS-035`,`DATA-ROOM-012`。
  Spec refs: `31` 3-6, `24` `DATA-ROOM-012`
  产出:
  客户端 `txnId` 幂等、redaction 规则、错误模型。
  完成标准:
  同一幂等键同 hash 返回同结果，不同 hash 返回 deterministic conflict。

### 06.04 实现房间查询面

- [ ] 实现 `IF-CS-034`,`IF-INT-ROOM-003`,`FLOW-CS-ROOM-QUERY`。
  Spec refs: `31` 10, `24` 4.1, `25` `FLOW-CS-ROOM-QUERY`
  产出:
  `/messages`,`/context`,`/event`,`/state`,`/members`,`/joined_members`,`/relations`,`/threads`,`/timestamp_to_event`。
  完成标准:
  读路径按热元数据 + 冷归档指针工作，不依赖 R2 list/scan。

### 06.05 实现本地 fanout 与 repair 钩子

- [ ] 实现 `IF-INT-USER-003`,`DATA-ROOM-011`,`FLOW-ROOM-LOCAL-FANOUT`,`FLOW-ROOM-FANOUT-REPAIR`,`STATE-ROOM-FANOUT-DELIVERY`。
  Spec refs: `31` 8, `24` `DATA-ROOM-011`, `25` 对应 flow/state
  产出:
  durable outbox、`UserDO` durable append ack、repair API / background hook。
  完成标准:
  `/sync` 可见性建立在 durable fanout 上，而不是易失内存上。

### 06.06 实现房间 receipts / typing

- [ ] 实现 `IF-CS-019`,`DATA-ROOM-009`,`DATA-ROOM-010`,`IF-ALARM-002`。
  Spec refs: `31` 9, `23` `IF-ALARM-002`
  产出:
  receipt current view、typing current view、typing expiry alarm。
  完成标准:
  ephemeral 状态失败不污染 room truth。

### 06.07 实现房间版本策略

- [ ] 完成 room version `12` 的基线实现，并为 `11` 预留/实现策略封装。
  Spec refs: `12` `MX-RV-011`~`013`, `31` 6
  产出:
  room version strategy layer、auth/state resolution hooks。
  完成标准:
  `L1` 至少支持 `12`；`L2` 进入前要完成 `11/12` 差异路径。

## Phase 07: Media And Derived Services

目标：补齐 L1 的媒体与派生查询面。

### 07.01 实现本地媒体上传

- [ ] 实现 `IF-CS-050`,`IF-INT-MEDIA-001`,`IF-INT-MEDIA-002`,`DATA-USER-015`,`DATA-R2-001`。
  Spec refs: `33` 2-3, `24` `DATA-USER-015`,`DATA-R2-001`, `25` `FLOW-CS-MEDIA-UPLOAD`
  产出:
  配额校验、pending upload、流式写 R2、finalize。
  完成标准:
  上传失败不会留下不可恢复的 pending grant。

### 07.02 实现本地媒体下载与 legacy freeze 语义

- [ ] 实现 `IF-CS-051`,`FLOW-CS-MEDIA-DOWNLOAD`,`DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003`。
  Spec refs: `33` 4, 6, `24` 7, `25` `FLOW-CS-MEDIA-DOWNLOAD`
  产出:
  authenticated current routes、deprecated unauthenticated compatibility routes、freeze 判断。
  完成标准:
  legacy unauthenticated 路由不会被 current authenticated surface 混淆。

### 07.03 实现远端媒体缓存

- [ ] 实现 `FLOW-CS-REMOTE-MEDIA-FETCH` 和远端抓取护栏。
  Spec refs: `33` 5, `25` `FLOW-CS-REMOTE-MEDIA-FETCH`, `13` `CF-WKR-006`
  产出:
  remote fetch pipeline、cache miss guard、same-key backoff。
  完成标准:
  freeze 后 deprecated unauthenticated 路由 cache miss 不触发新的远端抓取。

### 07.04 实现缩略图与生命周期管理

- [ ] 建立 thumbnail job、animated 变体隔离、orphan/pending 清理。
  Spec refs: `33` 6-7, `23` `IF-QUE-002`
  产出:
  thumbnail consumer、生命周期任务、清理逻辑。
  完成标准:
  animated/non-animated cache key 不互相污染。

### 07.05 实现搜索与目录派生面

- [ ] 实现 `IF-CS-052`,`IF-INT-WKR-001`,`IF-QUE-001`,`DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003`。
  Spec refs: `34` 2-5, `25` `FLOW-CS-SEARCH-QUERY`,`FLOW-SEARCH-INDEX`
  产出:
  index pipeline、query service、visibility fail-closed 逻辑。
  完成标准:
  匿名 `GET /publicRooms` 与鉴权态 `POST /publicRooms` 共用同一 query semantics。

### 07.06 实现 rebuild 能力

- [ ] 支持从 truth + archive 重建 search/user_directory/public_rooms。
  Spec refs: `34` 3.4, `42` 10, `25` `FLOW-REPLAY-REBUILD`
  产出:
  rebuild job、checkpoint、重放逻辑。
  完成标准:
  D1 派生表可完全从数据面真相重建。

## Phase 08: L1 Security, Observability, Compatibility, And Release Gate

目标：补齐 `Local-Core` 必需门禁，拿到第一个可验证 profile。

### 08.01 实现 baseline abuse guard

- [ ] 为注册、登录、媒体、房间发送、搜索、本地公开入口接入限流/配额。
  Spec refs: `40` 6, 6.1, `REQ-SEC-006`
  产出:
  粗粒度入口限流、主权对象内语义配额。
  完成标准:
  平台防护只是附加层，业务语义配额在应用层可见。

### 08.02 接入核心 metrics / logs / cost attribution

- [ ] 为 Worker、DO、D1、R2、Queue、控制面作业接入核心指标。
  Spec refs: `41` 2-9
  产出:
  指标埋点、结构化日志、最小成本面板字段。
  完成标准:
  `REQ-OPS-001`~`REQ-OPS-005` 有真实代码落位。

### 08.03 实现部署兼容与版本记录

- [ ] 建立 Worker version、deployment composition、compatibility date、CPU limit、startup_time 记录。
  Spec refs: `42` 2-8, `13` `CF-WKR-012`,`CF-WKR-025`
  产出:
  发布记录格式、版本兼容校验、secret rotation 记录。
  完成标准:
  `new Worker -> old DO` / `old Worker -> new DO` 兼容路径有实现基础。

### 08.04 完成 L1 测试

- [ ] 落地 `TEST-CS-001`,`TEST-CS-002`,`TEST-CS-003`,`TEST-CS-004`,`TEST-ROOM-001`,`TEST-ROOM-002`,`TEST-MEDIA-001`,`TEST-DER-001`,`TEST-SEC-001`,`TEST-OPS-001`,`TEST-COST-001`。
  Spec refs: `43` 3, 9
  产出:
  local / CI / staging 测试套件。
  完成标准:
  `L1` mandatory tests 全部可运行。

### 08.05 完成 L1 证据

- [ ] 生成 `EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001`。
  Spec refs: `44` 3, 4
  产出:
  对应 `evidence/L1/` 与 `evidence/common/` 证据包。
  完成标准:
  可以诚实声称达到 `L1 Local-Core`。

## Phase 09: Federation Core And L2 Gate

目标：在 `L1` 基础上完成联邦闭环。

### 09.01 实现联邦发现与元数据服务

- [ ] 实现 `FLOW-FED-DISCOVERY`,`FLOW-FED-METADATA-SERVE`,`IF-FED-001`。
  Spec refs: `32` 3-4, `25` 对应 flow, `13` `CF-NET-001`
  产出:
  远端发现算法、本地 server keys/version serve。
  完成标准:
  联邦不能假设入站走 `8448`。

### 09.02 实现联邦入站事务两阶段幂等

- [ ] 实现 `IF-FED-002`,`IF-INT-FED-002`,`DATA-FED-003`,`DATA-FED-006`,`FLOW-FED-INBOUND-TXN`。
  Spec refs: `32` 5, `24` 5.1, `25` `FLOW-FED-INBOUND-TXN`
  产出:
  inbound `send/{txnId}` 验签、去重、结果缓存。
  完成标准:
  相同 txn + 相同 hash 返回缓存结果，不同 hash 返回 deterministic conflict。

### 09.03 实现联邦出站排序与重试

- [ ] 实现 `IF-INT-FED-001`,`DATA-FED-001`,`DATA-FED-002`,`IF-ALARM-001`,`STATE-REMOTE-SERVER-RETRY`。
  Spec refs: `32` 6, 8; `25` 对应 flow/state
  产出:
  per-server 队列、退避、alarm 驱动重试。
  完成标准:
  同一远端服务器内保持稳定排序与同一 `txn_id` 重试。

### 09.04 实现 `make_join` / `send_join` / invite / leave / knock

- [ ] 完成 `IF-FED-003`,`FLOW-FED-JOIN-LEAVE`。
  Spec refs: `32` 5-6, `12` `MX-FED-005`, `25` `FLOW-FED-JOIN-LEAVE`
  产出:
  membership 联邦握手、模板、签名、提交。
  完成标准:
  任一步失败都不会污染本地房间真相。

### 09.05 实现联邦状态/事件查询与缺事件恢复

- [ ] 实现 `IF-FED-004`,`FLOW-FED-STATE-RETRIEVAL-SERVE`,`FLOW-FED-MISSING-EVENT-RECOVERY`。
  Spec refs: `32` 7, `25` 对应 flows
  产出:
  `event/state/state_ids/backfill/get_missing_events/timestamp_to_event`。
  完成标准:
  缺 `prev_events` / `auth_events` 场景可进入 bounded repair。

### 09.06 实现联邦查询面

- [ ] 实现 `IF-FED-006`,`FLOW-FED-QUERY`。
  Spec refs: `32` 9, `34` 5.1, `25` `FLOW-FED-QUERY`
  产出:
  `publicRooms`、hierarchy、directory、profile、generic query dispatch。
  完成标准:
  `publicRooms` 的 `GET` / `POST` 变体共用同一 query / visibility truth path。

### 09.07 实现联邦用户设备与密钥交换

- [ ] 实现 `IF-FED-007`,`IF-FED-008`,`FLOW-FED-USER-KEYS`。
  Spec refs: `32` 10, `25` `FLOW-FED-USER-KEYS`
  产出:
  `/user/devices`,`/user/keys/query`,`/user/keys/claim`。
  完成标准:
  one-time key 在联邦路径上同样保持 at-most-once。

### 09.08 实现联邦媒体服务与显式关闭路由

- [ ] 实现 `IF-FED-005`,`IF-FED-009`,`IF-FED-010`,`FLOW-FED-MEDIA-SERVE`,`FLOW-FED-DISABLED-ROUTE`。
  Spec refs: `32` 11-12, `23` 3.7
  产出:
  federation media serve、OpenID userinfo stub、3PID callback stub。
  完成标准:
  unsupported federation routes 不会因为 auth 差异产生漂移行为。

### 09.09 完成 L2 测试与证据

- [ ] 落地 `TEST-FED-001`,`TEST-FED-002`,`TEST-FED-003`,`TEST-FED-004`,`TEST-MEDIA-002` 并生成 `EVID-FED-001`,`EVID-FED-002`,`EVID-FED-003`。
  Spec refs: `43` 3, 9; `44` 3, 4
  产出:
  `staging` / `pre-release` 联邦测试和 `evidence/L2/` 证据包。
  完成标准:
  可以诚实声称达到 `L2 Federation-Core`。

## Phase 10: Enterprise Hardening, Recovery, Appservices, And L3 Gate

目标：完成企业级恢复、性能、运维与可选 appservice 能力。

### 10.01 实现 continuous checkpoint export

- [ ] 按 dirty shard 模式实现 checkpoint 导出，而不是固定全量 dump。
  Spec refs: `42` 11.2.1~11.2.1.2.1, `24` `DATA-R2-004`,`DATA-R2-005`,`DATA-OPS-011`
  产出:
  checkpoint scheduler、object codec、watermark 校验、R2 上传。
  完成标准:
  满足 `RPO <= 15 min` 目标的最小工程闭环。

### 10.02 实现 restore / rebuild / repair 全链路

- [ ] 完成 manifest 验证、restore apply order、cutover、repair decision log。
  Spec refs: `42` 10-11.3, `24` `DATA-OPS-001`,`DATA-OPS-002`,`DATA-OPS-003`
  产出:
  restore runner、repair runner、audit linkage。
  完成标准:
  能显式处理“truth 已提交但 registry 缺行”的故障注入场景。

### 10.03 实现 appservice 控制面与事务投递

- [ ] 完成 `IF-AS-001`,`IF-AS-002`,`DATA-D1-005`,`FLOW-AS-TXN-DELIVERY`,`STATE-APPSERVICE-TXN`。
  Spec refs: `34` 6-8, `25` 对应 flow/state
  产出:
  appservice config、namespace 裁决、txn queue、重试。
  完成标准:
  appservice 若启用，具备独立顺序与控制面管理。

### 10.04 实现 advanced abuse resistance 和条件能力边界

- [ ] 为 URL preview、push gateway、requestToken、TURN 等条件能力补安全隔离或保持关闭。
  Spec refs: `12` stub-only / conditional 条目, `33` 8, `40` 6, `43` `TEST-SEC-002`
  产出:
  advanced security controls，或明确保持 stub-only 并验证。
  完成标准:
  条件能力不会在未闭环前被意外打开。

### 10.05 建立性能、容量与成本验证

- [ ] 落地 `/sync` 并发、热房间、derived lag、月度成本对账。
  Spec refs: `41` 7-10, `43` `TEST-PERF-001`,`TEST-PERF-002`,`TEST-COST-001`, `44` `EVID-PERF-001`,`EVID-COST-001`
  产出:
  pre-release 压测、成本面板、证据包。
  完成标准:
  性能预算和成本模型都有真实观测入口。

### 10.06 完成 L3 测试与证据

- [ ] 完成 `TEST-AS-001`,`TEST-SEC-002`,`TEST-OPS-002`,`TEST-PERF-001`,`TEST-PERF-002` 并生成 `EVID-AS-001`,`EVID-OPS-002`,`EVID-PERF-001`。
  Spec refs: `43` 3, 9; `44` 3, 4
  产出:
  `evidence/L3/` 与 `evidence/common/` 对应证据。
  完成标准:
  可以诚实声称达到 `L3 Enterprise-Hardening`。

## Ongoing Loop: Research -> Spec -> Development -> Verification -> Debug

- [ ] 建立“发现平台或协议漂移时必须先更新 `15-source-observation-register.md`，再决定改 Spec 还是加 `OQ/DEC`”的例行流程。
  Spec refs: `11` 4, `15`
  产出:
  周期性 source review 任务和记录模板。
  完成标准:
  `latest` 漂移不会直接渗透到代码。

- [ ] 建立“每次行为变更必须同时检查 `REQ/MX/CF/IF/DATA/FLOW/STATE/TEST/EVID` 联动”的代码评审清单。
  Spec refs: `14` 4-7
  产出:
  PR checklist、review 模板。
  完成标准:
  后续开发不会退化成 code-first。

- [ ] 建立“TODO 项完成后必须回写完成证据、未决点、阻塞项”的工作习惯。
  Spec refs: root `AGENTS.md`, 本文件
  产出:
  任务更新模板。
  完成标准:
  `TODO.md` 能持续反映真实项目状态，而不是一次性文档。
