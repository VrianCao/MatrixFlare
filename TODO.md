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

- [x] 建立显式环境变量、secret、feature gate、compatibility date/flags 管理层。
  Spec refs: `10` `REQ-GOV-004`, `13` `CF-WKR-013`~`CF-WKR-022`, `CF-WKR-026`, `40` 5
  产出:
  配置加载模块、环境 schema、secret 访问封装。
  完成标准:
  无业务代码直接读取散乱环境变量或 secret 名称；wrangler 配置显式钉住所需 `compatibility_flags` 并与 runtime manifest 快照保持一致。

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

- [x] 实现 `Cf-Access-Jwt-Assertion` 验证、JWK 刷新、`principal_id` 映射、scope 判定。
  Spec refs: `40` 3.3, 3.3.1, 3.3.2; `24` `DATA-D1-006`; `26` 5; `13` `CF-NET-004`~`CF-NET-006`
  产出:
  Access JWT 验证器、operator authz middleware、`DATA-D1-006` 访问层。
  完成标准:
  控制面只信任 Access JWT，不直接信任 service token headers 或 cookie。

### 02.02 实现 `DATA-OPS-004` 审计与控制面幂等

- [x] 建立 `audit_event` + `request_dedupe_projection`。
  Spec refs: `24` 8, 8.1; `40` 8.2, 8.3; `26` 5
  产出:
  D1 schema、写入事务、重复请求折叠逻辑。
  完成标准:
  所有控制面写请求都能“先审计、后副作用”。

### 02.03 实现 `IF-OPS-001`~`IF-OPS-008`

- [x] 完成 healthz/readyz、jobs create/query/cancel、appservice config 控制面接口。
  Spec refs: `23` 3.8, `26` 5, `42` 12
  产出:
  `ops-worker` HTTP handlers、payload 验证、错误模型。
  完成标准:
  控制面不需要临时脚本即可启动 export/rebuild/repair/restore/appservice 管理。

### 02.04 实现 `DATA-OPS-010` / `DATA-OPS-011` shard registry

- [x] 建立 shard registry、registry snapshot、post-commit success barrier 语义。
  Spec refs: `24` 8, 8.2; `42` 11.2.0
  产出:
  D1 schema、upsert 规则、snapshot 生成逻辑。
  完成标准:
  新 shard 的创建、注册、快照冻结都有确定实现路径。

### 02.05 实现 control-plane job state 与 payload

- [x] 落地 `JobHandle`、`JobSummary`、`ExportJobSpec`、`RestoreJobSpec`、`RebuildJobSpec`、`RepairJobSpec` 等 payload。
  Spec refs: `26` 5.1-6.4, `42` 10-12
  产出:
  控制面 payload 类型、作业状态存储、状态机实现。
  完成标准:
  `STATE-REBUILD-JOB`、`STATE-EXPORT-JOB`、`STATE-RESTORE-JOB`、`STATE-REPAIR-JOB` 有代码落位。

### 02.06 建立 `jobs-worker` 作业框架与 Queue consumer

- [x] 建立统一 job dispatcher、queue consumer、checkpoint 机制。
  Spec refs: `21` 6, `23` 4.2, `26` 6.5, `42` 10
  产出:
  `jobs-worker` 作业总线、queue handlers、job checkpoint 存储。
  完成标准:
  任一重建/导出/修复作业都可断点续跑。

### 02.07 实现导出/恢复 manifest 编码

- [x] 落地 checkpoint manifest、bundle manifest、registry snapshot、R2 object key 规则。
  Spec refs: `24` `DATA-R2-005`, `24` 8.3, `42` 11.2.1~11.2.4, `26` 6.4-6.5
  产出:
  manifest types、hash/signature、R2 object key builder、completeness state。
  完成标准:
  统一 manifest artifact、签名/哈希、registry snapshot 与 object key 规则已经落地；restore checkpoint 绑定与 checkpoint object completeness 在 02.08 继续收口。

### 02.08 收敛 Phase 02 审查残项

- [x] 完成 restore checkpoint 解析与 `RestoreShardJob.checkpoint_id` 的真实来源绑定。
  Spec refs: `23` `IF-QUE-006`; `42` 11.2.1.4, 11.2.2
  产出:
  bundle manifest / checkpoint 选择逻辑、restore preflight checkpoint resolver。
  完成标准:
  restore queue payload 不再把 bundle hash 混作 checkpoint id，且能按 shard checkpoint 语义恢复。

- [x] 用真实 checkpoint object set 替换 placeholder checkpoint manifest，并补齐完整性 truth。
  Spec refs: `24` `DATA-OPS-002`, `DATA-R2-005`; `42` 11.2.1.1~11.2.1.3
  产出:
  checkpoint manifest object 列表、watermark、hash/signature/key-version、required object coverage。
  完成标准:
  checkpoint manifest 不再以 placeholder/incomplete 占位充数，restore / export completeness 能基于真实 manifest 裁决。

验证:
`tests/local/control-plane/control-plane.test.mjs`，`npm test`

### 02.09 收敛 Phase 00-02 深审残项

- [x] 修复 control-plane job payload 持久化与 queue batch 相关性链路的审查残项。
  Spec refs: `24` 8, 8.1-8.3; `25` `STATE-EXPORT-JOB`; `41` 2-5
  产出:
  `jobs.spec_json` 更新持久化、按消息粒度创建 `jobs-worker` queue async context、对应回归测试。
  完成标准:
  export job 在冻结 `registry_snapshot_id` / `export_epoch` 后，持久化 `spec_json` 与内存态一致；单个 queue batch 包含多个 `job_id` 时，日志与审计的 `job_id` / `causation_id` 不串号。

验证:
`tests/local/control-plane/control-plane.test.mjs`，`npm test`

### 02.10 收敛 Phase 00-02 深审残项（二）

- [x] 修复 `ops-worker` 内部启动 RPC 错误映射与治理证据快照残项。
  Spec refs: `23` 2, 2.1, `IF-OPS-002`~`IF-OPS-008`, `IF-INT-WKR-003`~`IF-INT-WKR-006`; `26` 4-6.5; `44` 2, 6
  产出:
  `jobs-worker` typed internal error 透传映射、`EVID-GOV-001` 的 code/data version 上下文、wildcard version-segment grammar 校验、route snapshot 缺失时的失败证据落盘、对应回归测试。
  完成标准:
  `ops-worker` 遇到 `jobs-worker` 的 `job_conflict` / `unsupported_schema_version` 等 typed internal error 时不会错误降格为 `internal`；治理工具会拒绝非法 wildcard family，且在 pinned Matrix route snapshot 缺失时仍能产出带失败状态的 `EVID-GOV-001` 证据与上下文。

验证:
`tests/local/control-plane/control-plane.test.mjs`，`tests/local/spec-tools/governance.test.mjs`，`npm test`

### 02.11 收敛 Phase 00-02 深审残项（三）

- [x] 修复 restore/export 状态机 fail-closed 与导出对象哈希语义残项。
  Spec refs: `23` `IF-QUE-005`,`IF-QUE-006`; `24` 8.2-8.3; `25` `STATE-EXPORT-JOB`,`STATE-RESTORE-JOB`; `26` 5.7-6.5; `42` 11.2.1-11.2.3
  产出:
  restore 缺 `DATA-OPS-011` frozen registry snapshot 时的 fail-closed、queue fatal error 统一推进 `job.failed`、`started_at` 持久化修复、archive bucket 缺失时的 snapshot freeze fail-closed、bundle manifest 对 registry/checkpoint manifest object 的 `content_hash(raw_bytes)` 修复、对应回归测试与 `25/26` 状态集合对齐。
  完成标准:
  full namespace restore 不会把缺 snapshot 的 bundle 误判为可完成；任何非重试型 queue 错误都不会把 job 卡在非终态；队列驱动后的终态 job 保留首个 `started_at`；manifest object `content_hash` 与实际 R2 JSON bytes 一致，而不是误用 manifest hash。

验证:
`tests/local/control-plane/control-plane.test.mjs`，`npm test`

### 02.12 收敛 Phase 00-02 深审残项（四）

- [x] 修复 Phase 02 export materialization 对未实现 shard 的假成功风险。
  Spec refs: `23` `IF-INT-USER-006`,`IF-INT-ROOM-004`,`IF-INT-FED-003`,`IF-QUE-005`; `24` `DATA-OPS-010`,`DATA-OPS-011`,`DATA-R2-005`; `42` 11.2.0, 11.2.1.3, 11.2.2
  产出:
  `start-export` 的 frozen registry snapshot fail-closed 校验、queue consumer 对非 `control-plane/ops-core` export shard 的二次拒绝、对应回归测试。
  完成标准:
  当前 Phase 02 runtime 不会把 `RoomDO` / `UserDO` / `RemoteServerDO` 或其他非 `control-plane/ops-core` shard 误物化成 control-plane checkpoint；若 frozen registry snapshot 或 queue 消息越过了当前实现边界，job 必须 deterministically fail-closed。

验证:
`tests/local/control-plane/control-plane.test.mjs`，`npm test`

## Phase 03: Core Data Plane Storage And Schemas

目标：把所有主权面和派生面的基础 schema 一次性按 Spec 钉住。

### 03.01 落地 `UserDO` schema

- [x] 建立 `DATA-USER-001`~`DATA-USER-017`。
  Spec refs: `24` 3, `30`
  产出:
  `UserDO` SQLite schema、schema_version、访问层。
  完成标准:
  session/device/key/account_data/profile/push_rules/pending_upload/to-device/dedupe 都有权威存储。

### 03.02 落地 `RoomDO` schema

- [x] 建立 `DATA-ROOM-001`~`DATA-ROOM-012`。
  Spec refs: `24` 4, `31`
  产出:
  `RoomDO` SQLite schema、查询索引、fanout outbox、客户端幂等表。
  完成标准:
  房间事件元数据、快照、membership、ephemeral、fanout、idempotency 全部可持久化。

### 03.03 落地 `RemoteServerDO` schema

- [x] 建立 `DATA-FED-001`~`DATA-FED-006`。
  Spec refs: `24` 5, `32`
  产出:
  `RemoteServerDO` SQLite schema、两阶段入站 txn 去重与结果缓存。
  完成标准:
  出站队列、退避、入站去重、gap repair backlog 都有主权存储。

### 03.04 落地 D1 派生面与控制面 schema

- [x] 建立 `DATA-D1-001`~`DATA-D1-006`。
  Spec refs: `24` 6, `34`, `40`, `42`
  产出:
  search index、user directory、public rooms、media catalog、appservice config / delivery_state、operator authz policy 表。
  完成标准:
  D1 上只有派生面和控制面权威元数据，没有数据面权威真相。

### 03.05 落地 R2 / KV keyspace

- [x] 建立 `DATA-R2-001`~`DATA-R2-006`、`DATA-KV-001`~`DATA-KV-002` 的对象键空间和 metadata 规则。
  Spec refs: `24` 7, `33`, `42`
  产出:
  key builders、metadata schema、读写封装。
  完成标准:
  本地媒体、远端媒体缓存、缩略图、房间冷归档、导出对象、backup segment 都可按固定模式落盘。

验证:
`tests/local/runtime-foundations/data-plane-storage.test.mjs`，`npm test`

## Phase 04: Discovery, Session, Identity, UIA, And Stub Guards

目标：先完成 L1 入口层和所有必须 deterministic 的 disabled truth。

### 04.01 实现公开 discovery 面

- [x] 实现 `IF-PUB-001`,`IF-PUB-002`,`IF-CS-001`,`IF-CS-002`,`IF-CS-005`,`IF-CS-009`,`IF-CS-066`,`IF-CS-067`。
  Spec refs: `23` 3.1, `30` 4-5, `31` 2/6, `32` 3, `25` `FLOW-CS-DISCOVERY`,`FLOW-FED-METADATA-SERVE`
  产出:
  `/.well-known`、`/versions`、`/capabilities`、`/login`、`/register` compatibility discovery、`/register/available`、registration token validity handlers。
  完成标准:
  discoverability truth 与当前启用能力完全一致。
  当前状态:
  `gateway-worker` 现在会对 `/.well-known/matrix/client`、`/_matrix/client/versions` 与 `/_matrix/client/*` 的 browser `Origin` 请求统一附加 CORS 响应头，并在 `OPTIONS` preflight 时直接返回 `204`，不再把标准浏览器预检请求误落到 `M_UNRECOGNIZED`；同时 `/_matrix/client/versions` 也已从“只返回 `v1.17`”修正为 browser-client 可接受的 cumulative stable ladder（至少 `r0.6.1` 与 `v1.1` 到 `v1.17`），避免当前官方 Matrix browser client 把 homeserver 误判为“不满足最低 API 版本”。该修正的解释边界现由 `DEC-0007` 固定：这是 browser compatibility discovery contract，不等于放宽 `DEC-0001` 的 stub-only / unsupported product boundary。随后又根据真实 browser `createRoom` failure 补上 `GET /_matrix/client/*/capabilities` 的 `m.room_versions` truth：当前实现已显式宣告 `default = 12` 且 `available.{11,12} = stable`，避免 Web client 因 capability 缺失回退到 legacy room version `1`。

### 04.02 实现 Access/Refresh token 真相与 session 解析

- [x] 实现 `DATA-ID-003`,`DATA-ID-004`,`IF-INT-USER-001`,`STATE-USER-SESSION`。
  Spec refs: `24` 2, `30` 3, `40` 2-3
  产出:
  session parser、token hash 校验、session lifecycle。
  完成标准:
  所有认证态请求都只能经 `UserDO` 判定 session 有效性。

### 04.03 实现注册 / 登录 / 刷新 / 注销 / whoami

- [x] 完成 `IF-CS-010`~`IF-CS-014`。
  Spec refs: `30` 4.2, 4.3, 4.6, 4.7, 4.8; `25` `FLOW-CS-REGISTER`,`FLOW-CS-LOGIN`,`FLOW-CS-REFRESH`
  产出:
  对应 handlers、`UserDO` command path、幂等与错误模型。
  完成标准:
  无半创建、无半 session；refresh 语义与 Matrix `v1.17` 对齐，即旧 refresh token 只在新 access / 新 refresh 尚未被使用前可 retry，并收敛到同一 rotated lineage；一旦当前 access 或当前 refresh 已被使用，旧 refresh 必须可判失效。
  当前状态:
  `/_matrix/client/{r0,v1,v3}/login`、`/_matrix/client/{r0,v1,v3}/register` 与 `/_matrix/client/{r0,v1,v3}/register/available` 现已按同一 password / dummy truth 收口；`TEST-CS-001` / `EVID-CS-001` 也已同步抬高为逐别名锁定 `/.well-known/matrix/client`、`/_matrix/client/versions`、discovery / availability truth、`Cache-Control` 真值、browser `Origin` + `OPTIONS` preflight、anonymous public-entry alias-matrix bounded-window live `429 M_LIMIT_EXCEEDED` + `200/429` envelope truth、初始 UIA challenge、成功 registration/login、错误模型，以及 `access_token` / `refresh_token` issuance 与 `device_id` 副作用 parity 的 gate；shared public-entry wiring 则继续由 companion local runtime controls fail-closed 锁定，而不是由 non-local `429` probe 单独推断。同时 `TEST-GOV-001` 本地治理检查也显式钉住 `IF-CS-005`,`IF-CS-009`,`IF-CS-067`,`IF-CS-010`,`IF-CS-011` 的 route-set，避免 compatibility alias drift 被便利性绿灯漏掉。

### 04.04 实现共享 UIA 模型、密码变更、账户停用

- [x] 完成 `DATA-ID-006`,`IF-CS-006`,`IF-CS-008`,`STATE-UIA-SESSION`。
  Spec refs: `30` 4.1, 4.4, 4.5; `26` 6.2; `40` 3.1
  产出:
  route-bound UIA token、password change、deactivate command path。
  完成标准:
  UIA token 不可跨路由/跨主体重放，`auth_version` 推进正确。

### 04.05 实现 deterministic stub / unsupported route guards

- [x] 实现 `IF-CS-007`,`IF-CS-053`~`IF-CS-065` 与对应 discoverability 收口。
  Spec refs: `12` stub-only 条目, `23` 3.6, `25` `FLOW-CS-DISABLED-ROUTE`
  产出:
  固定 `404 M_UNRECOGNIZED` / `401 M_UNKNOWN_TOKEN` guards、短路中间件。
  完成标准:
  stub route 在 access token、UIA、provider callout、业务 dispatch 之前短路。

## Phase 05: Profile, Account Data, Push Rules, To-Device, Presence, Sync

目标：完成用户域的真正 L1 使用面。

### 05.01 实现 profile truth 与传播

- [x] 实现 `IF-CS-017`,`DATA-USER-012`,`FLOW-CS-PROFILE-PROPAGATION`。
  Spec refs: `30` 5.2, `24` `DATA-USER-012`, `25` `FLOW-CS-PROFILE-PROPAGATION`
  产出:
  profile GET/PUT/DELETE、`displayname/avatar_url` 传播、`profile_version` 去重。
  完成标准:
  `m.tz` 与 custom field 语义也被正确支持。
  当前状态:
  profile truth、`m.tz`、custom field、`profile_version`、presence propagation 与 joined-room `m.room.member` refresh 已通过 `RoomDO` durable fanout / `/sync` 投影回归验证。

### 05.02 实现 account data / tags / read markers

- [x] 实现 `IF-CS-015`,`DATA-USER-006`,`DATA-USER-007`。
  Spec refs: `30` 5.3, `24` `DATA-USER-006`,`DATA-USER-007`
  产出:
  global/room account data、tags、read markers handlers。
  完成标准:
  所有变更进入 `user_stream`。

### 05.03 实现 push rules 与 notification state

- [x] 实现 `IF-CS-018`,`DATA-USER-013`，并接入 `push rules` 基线。
  Spec refs: `30` 5.4, `43` 6
  产出:
  push rule CRUD、顺序调整、enabled 状态、默认规则基线装载。
  完成标准:
  运行时默认规则可与 `v1.17` 基线逐条比对。
  当前状态:
  push rule CRUD、`before/after` 顺序、`actions` / `enabled` 子资源、`v1.17` baseline 回归，以及经由房间 fanout / `RoomDO.projectForSync()` surfaced 的 unread / notification state 已验证。

### 05.04 实现 to-device 与幂等裁决

- [x] 实现 `IF-CS-041`,`IF-INT-USER-005`,`DATA-USER-008`,`DATA-USER-016`。
  Spec refs: `30` 5.5, `24` `DATA-USER-008`,`DATA-USER-016`, `25` `FLOW-CS-SEND-TO-DEVICE`
  产出:
  public handler、local enqueue、dedupe registry、设备消费。
  完成标准:
  同一 public txn key 重试不会重复入队。

### 05.04A 实现 devices / E2EE transport / backup metadata

- [ ] 实现 `IF-CS-040`,`IF-CS-042`,`IF-CS-043`,`IF-CS-044`,`IF-CS-045`,`IF-CS-046`,`IF-CS-047`,`IF-INT-USER-004`,`DATA-USER-002`,`DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-011`,`DATA-R2-006`。
  Spec refs: `30` 4.1, 5.5, 5.7, 6; `24` `DATA-USER-002`,`DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-011`,`DATA-R2-006`; `25` `FLOW-CS-DEVICE-MANAGEMENT`; `43` `TEST-CS-003`; `44` `EVID-CS-003`
  产出:
  device CRUD、keys upload/query/claim、cross-signing upload/signatures、room key backup metadata / object handling、对应 gateway handler 与 `UserDO` 裁决路径。
  完成标准:
  `TEST-CS-003` 可在本地与 non-local 路径上被诚实实现，并验证 one-time key at-most-once、device surfaces、cross-signing surfaces、`/sync` device truth 与 backup metadata。
  当前状态:
  官方 Matrix `v1.17` 核对后新增的 cross-signing route truth（`POST /_matrix/client/v3/keys/device_signing/upload`,`POST /_matrix/client/v3/keys/signatures/upload`）已同步补入 `12/23/25/30/43/44/TODO`，`apps/gateway-worker/src/index.mjs` 与 `UserDO` 也已真实落位 `IF-CS-040`,`IF-CS-042`~`IF-CS-047` 对应公共入口与裁决路径，不再存在“只剩 sendToDevice、devices/keys/room_keys 还没接路由”的旧 blocker。当前本地实现前置由 `tests/local/client-identity/phase-05.test.mjs` 与 `tests/local/client-identity/phase-05a.test.mjs` 共同收口：前者覆盖 to-device transport，后者覆盖 device CRUD/delete UIA replay、keys upload/query/claim、cross-signing upload/signature mismatch、`/sync` device truth 与 room key backup metadata/object handling。
  本轮还新增了 dedicated staging canonical suite `tests/staging/test-cs-003.test.mjs`，并把 `packages/testing/src/evidence.mjs` 的 `TEST-CS-003 -> staging` mapping 接入 strict parser；本地重新执行 fail-closed `evidence:l1` 时，`EVID-CS-003` 的 `mapping_error` 已清零，说明当前 blocker 已不再是“缺 staging canonical suite / mapping”。但本项完成标准仍要求当前代码状态拿到真实 non-local attested pass；在 GitHub Actions 重新执行 `staging` 环境并让 `EVID-CS-003` 由 attestation-backed run 诚实转为 `pass` 前，`05.04A` 继续保持未完成，并由 `08.04` / `08.05` 收口其 non-local 证明链。

### 05.05 实现 presence

- [x] 实现 `IF-CS-016`,`DATA-USER-009`。
  Spec refs: `30` 5.6
  产出:
  presence 读写、presence 版本推进、进入 `user_stream`。
  完成标准:
  presence 当前值不与 profile/account data 混用。

### 05.06 实现 filters、sync token、user stream

- [x] 实现 `IF-CS-003`,`IF-CS-004`,`DATA-ID-001`,`DATA-USER-010`,`IF-INT-USER-002`。
  Spec refs: `30` 5.1, 7, 8, 9; `22` 4
  产出:
  stored filter、inline filter 规范化、`next_batch` 编码、collectSince。
  完成标准:
  token 对客户端 opaque，内部至少编码版本与 `user_stream_pos`。
当前状态:
  stored/inline filter 解析、带完整性保护的 opaque `next_batch`、`collectSince()`、room/account-data/ephemeral 分类收集，以及 `RoomDO` durable fanout -> `DATA-USER-010` append 路径已验证。

### 05.07 实现 Worker-held `/sync`

- [x] 完成 `IF-CS-020`,`IF-INT-USER-007`,`STATE-SYNC-WAITER`,`FLOW-CS-SYNC-LONGPOLL`。
  Spec refs: `30` 8-10, `25` `FLOW-CS-SYNC-LONGPOLL`,`STATE-SYNC-WAITER`, `13` `CF-WKR-001`
  产出:
  long-poll handler、single waiter 规则、wake channel、assemble path。
  完成标准:
  早返回不会推进 token，deploy 中断视为正常重试路径。
当前状态:
  worker-held waiter、single-session supersede、early-return 语义、默认 `set_presence=online` / 默认 `timeout=0` 的 Matrix `v1.17` `/sync` 语义、经 `IF-INT-USER-007` 落地且仅在请求校验成功后才生效的 auto-presence touch、完整性保护的 `next_batch`，以及按 `30` 8.3 降级路径落地的 bounded re-collect polling 长轮询已通过回归验证。

## Phase 06: Room Core, Room Versions, And Local Fanout

目标：完成 L1 的房间正确性核心。

### 06.00A 补齐房间域 REQ 闭环

- [x] 在 `31-room-processing-and-room-versions.md` 增加 `REQ-ROOM-001`~`REQ-ROOM-007`，并同步更新 traceability sidecar。
  Spec refs: `11` 6.1, `14` 3.1, 7.2, `31` 1.1
  产出:
  canonical `REQ-ROOM-*` rows、`REQ -> IF/DATA/FLOW/STATE/TEST/EVID` sidecar edges、合法的房间域实现前置。
  完成标准:
  Phase 06 实现能映射到 owning spec 的 `REQ-ROOM-*`，且治理工件可机审追溯。
  当前状态:
  `31` 已补齐房间域 canonical requirement rows，`14-requirement-traceability-sidecar.json` 已补全 `REQ-ROOM-*` 映射，Phase 06 进入符合仓库策略的 `SR2/SR3` 实现状态。

### 06.00 补齐 `/sync` 房间投影前置

- [x] 实现 `IF-INT-ROOM-002`、`RoomDO.projectForSync()` 与本地房间 fanout -> `UserDO` 用户流桥接前置。
  Spec refs: `23` `IF-INT-ROOM-002`; `30` 7.3, 8.2 step 7, 9.1-9.5; `31` 8, 9; `24` `DATA-ROOM-007`,`DATA-ROOM-011`
  产出:
  `RoomProjectionRequest` / `RoomSyncProjection`、membership bucket truth、`DATA-ROOM-011` durable outbox -> `DATA-USER-010` append 路径、notification/unread 重算信号。
  完成标准:
  `gateway-worker` 不再合成 synthetic `rooms.join`；所有房间 `/sync` 片段都由 `RoomDO` 投影并按 user/room visibility context 组装。
  当前状态:
  `RoomDO.projectForSync()`、`UserDO.appendRoomFanout()`、`deliverPendingFanout()`、profile membership refresh fanout，以及 `gateway-worker` room projection assembly 已经落地并通过 Phase 05 `/sync` 回归与全量本地测试。

### 06.01 实现统一事件接纳流水线

- [x] 实现 `IF-INT-ROOM-001`,`FLOW-ROOM-EVENT-ADMISSION`,`STATE-ROOM-EVENT-ADMISSION`。
  Spec refs: `31` 3-5, `25` 对应 flow/state
  产出:
  event validation、auth checks、state resolution、commit path。
  完成标准:
  本地客户端写入已接通统一准入管道；后续联邦 / AS / repair / backfill ingress 进入实现时也必须复用同一 `RoomDO.admitEvent()`，不得另起旁路。
  当前状态:
  `RoomDO.admitEvent()` 已落地统一 validation/auth/state snapshot/commit/dedupe/fanout 流水线，`request_kind` 已为 client/federation/appservice/repair/backfill 预留统一裁决入口；Phase 06 本地路由与回归当前覆盖 client ingress，后续域入口必须接到同一 admission 面。

### 06.02 实现房间创建与 membership 变更

- [x] 实现 `IF-CS-030`,`IF-CS-031`,`FLOW-CS-ROOM-MEMBERSHIP`,`STATE-ROOM-MEMBERSHIP`。
  Spec refs: `31` 4, 6, 11, 12
  产出:
  create/join/invite/leave/ban/unban/kick/knock/forget。
  完成标准:
  membership 当前视图与房间提交原子同步。
  当前状态:
  `gateway-worker` 已接通 create/join/invite/leave/ban/unban/kick/knock/forget；room truth 相关 membership 变更与 profile refresh 都统一经 `RoomDO.admitEvent()` 原子推进，`forget` 只在 `UserDO` 收敛本地可见性而不改写 `RoomDO` 真相；`{roomIdOrAlias}` 路由当前对 `room_id` 形态可用，alias lookup 仍依赖后续目录 phase 落地。

### 06.03 实现消息发送 / 状态事件 / redaction

- [x] 实现 `IF-CS-032`,`IF-CS-033`,`IF-CS-035`,`DATA-ROOM-012`。
  Spec refs: `31` 3-6, `24` `DATA-ROOM-012`
  产出:
  客户端 `txnId` 幂等、redaction 规则、错误模型。
  完成标准:
  同一幂等键同 hash 返回同结果，不同 hash 返回 deterministic conflict。
  当前状态:
  `/send`、`/state`、`/redact` 已经接入 `RoomDO`；`/send` 显式 `txnId`、`/state` 路径稳定 dedupe key 与 `/redact` 显式 `txnId` 路由都满足 same body same result / different body conflict，redaction 与房间版本差异路径已由 Phase 06 本地测试验证。

### 06.04 实现房间查询面

- [x] 实现 `IF-CS-034`,`IF-INT-ROOM-003`,`FLOW-CS-ROOM-QUERY`。
  Spec refs: `31` 10, `24` 4.1, `25` `FLOW-CS-ROOM-QUERY`
  产出:
  `/messages`,`/context`,`/event`,`/state`,`/members`,`/joined_members`,`/relations`,`/threads`,`/timestamp_to_event`。
  完成标准:
  当前热路径统一经 `RoomDO.queryRoom()` 的 metadata / visibility 裁决面工作；未来接入 cold-hit 时也不得引入 R2 list/scan 旁路。
  当前状态:
  所有 Phase 06 房间读路由都已经由 `gateway-worker -> RoomDO.queryRoom()` 规范化，按热元数据、可见性与 membership 边界返回结果；Phase 06 本地测试已覆盖全部查询面及 invited/knocked 非法读取的 fail-closed。

### 06.05 实现本地 fanout 与 repair 钩子

- [x] 实现 `IF-INT-USER-003`,`DATA-ROOM-011`,`FLOW-ROOM-LOCAL-FANOUT`,`FLOW-ROOM-FANOUT-REPAIR`,`STATE-ROOM-FANOUT-DELIVERY`。
  Spec refs: `31` 8, `24` `DATA-ROOM-011`, `25` 对应 flow/state
  产出:
  durable outbox、`UserDO` durable append ack、repair API / background hook。
  完成标准:
  `/sync` 可见性建立在 durable fanout 上，而不是易失内存上。
  当前状态:
  `RoomDO` durable outbox、`UserDO.appendRoomFanout()` ack、`deliverPendingFanout()` 与 `reconcileFanout()` 已落地；`ops-worker -> jobs-worker -> RoomDO.reconcileFanout()` 的 `room_user_fanout` repair hook 现已接通 room/user scoped 背景修复，本地 Phase 06 测试显式注入缺失 outbox / 缺失 user stream 后验证 repair 可重建并补 ack，control-plane 测试则覆盖 `user_id` / `room_id` scoped dispatch 与多轮 reconcile 直至 `has_more = false`。

### 06.06 实现房间 receipts / typing

- [x] 实现 `IF-CS-019`,`DATA-ROOM-009`,`DATA-ROOM-010`,`IF-ALARM-002`。
  Spec refs: `31` 9, `23` `IF-ALARM-002`
  产出:
  receipt current view、typing current view、typing expiry alarm。
  完成标准:
  ephemeral 状态失败不污染 room truth。
  当前状态:
  `/typing`、`/receipt`、`RoomDO.expireTypingAlarm()` 与 `UserDO` ephemeral append 已落地，`RoomDO` 现在会真实 schedule/reschedule/delete DO typing alarm；Phase 06 本地测试覆盖 typing/receipt 成功与失败两种增量 `/sync` 可见性、typing 过期清理，以及 ephemeral 投递失败不污染 room truth。

### 06.07 实现房间版本策略

- [x] 完成 room version `12` 的基线实现，并为 `11` 预留/实现策略封装。
  Spec refs: `12` `MX-RV-011`~`013`, `31` 6
  产出:
  room version strategy layer、auth/state resolution hooks。
  完成标准:
  `L1` 至少支持 `12`；`L2` 进入前要完成 `11/12` 差异路径。
  当前状态:
  `packages/runtime-core/src/room-domain.mjs` 已封装 room version 默认值、支持集、create-room identity、cursor 与 redaction helper；`RoomDO` admission/auth 当前已通过本地测试验证默认 `12`、显式 `11`、`creation_content` 不得覆写已裁决的 room version、缺失事件 fail-closed、`11` redaction auth 差异与 `11/12` redaction 结果差异。`TEST/EVID-ROOM-*` 的 CI/staging 闭环仍以后续 `08.04` / `08.05` 为准。

## Phase 07: Media And Derived Services

目标：补齐 L1 的媒体与派生查询面。

### 07.01 实现本地媒体上传

- [x] 实现 `IF-CS-050`,`IF-INT-MEDIA-001`,`IF-INT-MEDIA-002`,`DATA-USER-015`,`DATA-R2-001`。
  Spec refs: `33` 2-3, `24` `DATA-USER-015`,`DATA-R2-001`, `25` `FLOW-CS-MEDIA-UPLOAD`
  产出:
  配额校验、pending upload、流式写 R2、finalize。
  完成标准:
  上传失败不会留下不可恢复的 pending grant。

### 07.02 实现本地媒体下载与 legacy freeze 语义

- [x] 实现 `IF-CS-051`,`FLOW-CS-MEDIA-DOWNLOAD`,`DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003`。
  Spec refs: `33` 4, 6, `24` 7, `25` `FLOW-CS-MEDIA-DOWNLOAD`
  产出:
  authenticated current routes、deprecated unauthenticated compatibility routes、freeze 判断。
  完成标准:
  legacy unauthenticated 路由不会被 current authenticated surface 混淆。

### 07.03 实现远端媒体缓存

- [x] 实现 `FLOW-CS-REMOTE-MEDIA-FETCH` 和远端抓取护栏。
  Spec refs: `33` 5, `25` `FLOW-CS-REMOTE-MEDIA-FETCH`, `13` `CF-WKR-006`
  产出:
  remote fetch pipeline、cache miss guard、same-key backoff。
  完成标准:
  freeze 后 deprecated unauthenticated 路由 cache miss 不触发新的远端抓取。

### 07.04 实现缩略图与生命周期管理

- [x] 建立 thumbnail job、animated 变体隔离、orphan/pending 清理。
  Spec refs: `33` 6-7, `23` `IF-QUE-002`
  产出:
  thumbnail consumer、生命周期任务、清理逻辑。
  完成标准:
  animated/non-animated cache key 不互相污染。

### 07.05 实现搜索与目录派生面

- [x] 实现 `IF-CS-052`,`IF-INT-WKR-001`,`IF-QUE-001`,`DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003`。
  Spec refs: `34` 2-5, `25` `FLOW-CS-SEARCH-QUERY`,`FLOW-SEARCH-INDEX`
  产出:
  index pipeline、query service、visibility fail-closed 逻辑，以及 `join/knock {roomIdOrAlias}` 所需的 alias lookup。
  完成标准:
  匿名 `GET /publicRooms` 与鉴权态 `POST /publicRooms` 共用同一 query semantics。

### 07.06 实现 rebuild 能力

- [x] 支持从 truth + archive 重建 search/user_directory/public_rooms。
  Spec refs: `34` 3.4, `42` 10, `25` `FLOW-REPLAY-REBUILD`
  产出:
  rebuild job、checkpoint、重放逻辑。
  完成标准:
  D1 派生表可完全从数据面真相重建。
  当前状态:
  `jobs-worker` 的 rebuild 队列现已通过 `RoomDO.exportDerivedShard()` 与 `UserDO.getUserDirectoryEntry()` 从 truth + archive 重放 `search_index`、`user_directory`、`public_room_directory`，`tests/local/client-identity/phase-07.test.mjs` 已覆盖 archive-backed rebuild、`publicRooms` 等价 query semantics，以及 rebuild 后 D1 派生面与 truth 的一致性。

- [x] 为 `RoomDO` 的大 shard rebuild 实现 checkpointed 分批重放，跨多次 queue invocation 满足 D1 单 invocation 预算。
  Spec refs: `34` 3.4, `42` 10, `25` `STATE-REBUILD-JOB`
  产出:
  per-shard chunk cursor、幂等 clear/apply 语义、跨 invocation checkpoint 进度推进。
  完成标准:
  单 shard `search_index_rows` 超过单 invocation D1 budget 时仍可完成 rebuild，且不违反 `CF-D1-007` 到 `CF-D1-011`。
  当前状态:
  `buildRebuildShardJob()` / `jobs-handler` 现已为 `RoomDO` rebuild 记录 per-shard chunk cursor 与 checkpoint progress，并在单 shard 超过一次 D1 invocation 预算时自动拆成多次 `matrix-rebuild-shard-job` queue invocation；旧 chunk 的重复投递会按 checkpoint cursor fail-closed 为 stale，不会再次清空已推进的 shard。`tests/local/client-identity/phase-07.test.mjs` 已验证 `11,000` search rows 的 room shard 会分两次 queue invocation 完成 rebuild，并在 stale retry 下保持幂等 clear/apply 语义。

## Phase 08: L1 Security, Observability, Compatibility, And Release Gate

`2026-04-05` 新确认的结构性事实：若继续坚持“必须先通过正式 reviewed candidate promote，才能让 prod 给真实用户使用”，则 `OQ-0002` 会进入死锁，因为项目永远拿不到 fixed prod topology 的 post-install真实月度成本窗口。current accepted handling 见 `DEC-0006`：允许一条明确标记为 `operational_unblock` 的受控 `operational-prod-refresh` 路径，把当前 `master` 刷新到现有 prod topology，仅用于解开 `OQ-0002` / `OQ-0006` 成本闭环死锁；这不等于 `08.05` 完成，也不等于 `L1 Local-Core` 达成。

`2026-04-06` 新确认的 live prod/browser truth：Playwright 直连 `https://app.element.io` 并把 homeserver 指向当前 prod `https://matrix-gateway-worker-prod.yevdndjyebksug.workers.dev` 时，Element 在登录前就因 `/_matrix/client/versions` 仍只返回 `["v1.17"]` 而拒绝继续，说明 live prod 仍停在旧部署。对应 repair 已把 production readiness contract 明确收紧为“中间 rollout step 可暂时不要求 browser `/versions` ladder，但最终 `gateway-worker` `100%` cutover、generic browser smoke 与任何 browser-facing prod usable claim 都必须继续 fail-closed”；这条边界现由 `42` 与 `DEC-0007` 同步固定，不得再只改实现不改文档。

目标：补齐 `Local-Core` 必需门禁，拿到第一个可验证 profile。

### 08.01 实现 baseline abuse guard

- [x] 为注册、登录、媒体、房间发送、搜索、本地公开入口接入限流/配额。
  Spec refs: `40` 6, 6.1, `REQ-SEC-006`
  产出:
  粗粒度入口限流、主权对象内语义配额。
  完成标准:
  平台防护只是附加层，业务语义配额在应用层可见。
  当前状态:
  `packages/runtime-core/src/abuse-guard.mjs`、`apps/gateway-worker/src/index.mjs` 与 `packages/runtime-core/src/durable-objects.mjs` 已接通 gateway 入口限流与 `UserDO` / `RoomDO` 语义配额；覆盖注册、登录、媒体、搜索、本地公开入口，以及 room write / membership mutation（含 `join`、`knock`、`forget`）。`tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs` 已验证 gateway `429 M_LIMIT_EXCEEDED` 与应用层可见配额拒绝。

### 08.02 接入核心 metrics / logs / cost attribution

- [x] 为 Worker、DO、D1、R2、Queue、控制面作业接入核心指标。
  Spec refs: `41` 2-9
  产出:
  指标埋点、结构化日志、最小成本面板字段。
  完成标准:
  `REQ-OPS-001`~`REQ-OPS-005` 有真实代码落位。
  当前状态:
  `packages/runtime-core/src/telemetry.mjs` 与三类 Worker 入口现已记录 request metrics、结构化日志、deployment record、D1/R2/KV/Queue 指标与成本归因；`UserDO` / `RoomDO` 关键操作与 control-plane job 状态也已落真实指标。Phase 08 本地测试已验证 deployment/binding/derived-lag/cost attribution 信号存在。

### 08.03 实现部署兼容与版本记录

- [x] 建立 Worker version、deployment composition、compatibility date、CPU limit、startup_time 记录。
  Spec refs: `42` 2-8, `13` `CF-WKR-012`,`CF-WKR-025`
  产出:
  发布记录格式、版本兼容校验、secret rotation 记录。
  完成标准:
  `new Worker -> old DO` / `old Worker -> new DO` 兼容路径有实现基础。
  当前状态:
  `packages/runtime-core/src/deployment-records.mjs`、runtime manifest 与 worker env 已记录 `worker_version_id`、`deployment_id`、`compatibility_date`、`cpu_limit_class`、`startup_time_ms`、`deployment_composition`、`feature_gates` 与 `secret_versions`；`ops-worker` health 响应与 `spec/framework/26-wire-schema-catalog.md` 已同步扩展。Phase 08 版本偏斜测试已验证 `new Worker -> old DO` / `old Worker -> new DO` 的基础兼容路径。

### 08.04A 收敛 non-local evidence provenance contract

- [x] 通过 `DEC-0002` 固化 non-local evidence attestation contract，并关闭 `OQ-0003`。
  Spec refs: `26` 5.15-5.21, `43` 5, 11, `44` 2, 6, `DEC-0002`, `OQ-0003`
  产出:
  `EnvironmentRunAttestation` / `ProdCostSnapshotAttestation` schema、evidence CLI/manual-artifact fail-closed 校验、control documents 同步更新。
  完成标准:
  release gate 不再接受自由形状 non-local run report / prod snapshot JSON；attestation 至少要求 run identity、deployment identity、artifact store immutable reference、artifact digest 与 review record reference。
  当前状态:
  `spec/framework/26-wire-schema-catalog.md` 已登记 attestation bundle contract，`43/44` 已改为以 attestation 作为 non-local evidence 唯一入口，`spec/open-questions/OQ-0003.md` 已由 `DEC-0002` 关闭；`packages/testing/src/evidence.mjs` / `packages/testing/src/cli.mjs` 已转为按 attestation bundle 校验 provenance，而不是直接信任原始 report/snapshot JSON。validator 现会拒绝占位 / 非外部 URI 的 provenance locator，包括裸 `urn:` 与旧 `--*-report` / `--prod-cost-snapshot` CLI 别名，并在 `manual-artifacts.json` 中保留完整 attestation provenance snapshot 供审计回链。

### 08.04B 收敛 non-local ops Access topology prerequisite

- [x] 为 `staging` / `pre-release` 建立可审计的 Access-protected management ingress 与 automation contract（account-owned `workers.dev`/Preview URL 或 active-zone custom hostname），作为 `TEST-DER-001` rebuild consistency 和 `TEST-OPS-001` positive non-local gate 的前置条件。
  Spec refs: `21` 5, `22` 7, `23` `IF-OPS-001`,`IF-OPS-004`, `24` `DATA-D1-006`, `40` 3.3, 8, `42` 12, `13` `CF-NET-003`,`CF-NET-004`,`CF-NET-005`,`CF-NET-006`,`CF-NET-007`, `OQ-0004`
  产出:
  专用 Access-protected management ingress 方案（account-owned `workers.dev`/Preview URL 或 active-zone custom hostname）、Access application/service-auth automation contract、GitHub Actions 所需最小 secret/permission 清单或对应 blocker。
  完成标准:
  `ops-worker` 不再仅靠公开 `workers.dev` URL + `.cloudflareaccess.invalid` placeholder；non-local harness 能通过真实 Access ingress 到达 `/_ops`，且 `ops-worker` 收到的身份来源与 `CF-NET-004`-`006` / `DATA-D1-006` 一致。
  当前状态:
  当前 repo 已不再停留在 `.cloudflareaccess.invalid` placeholder 阶段。`packages/testing/src/nonlocal.mjs` 现会读取 Zero Trust organization `auth_domain`，在每个 non-local 环境对应的 account-owned `workers.dev` hostname 上 ensure Access application，创建/轮换稳定 service token，ensure 绑定该 token 的 service-auth policy，并在远端 D1 上 bootstrap control-plane schema 后 upsert `DATA-D1-006` operator policy；`.github/workflows/nonlocal-phase08.yml` 也已为 `staging` / `pre-release` 加入 `nonlocal-prepare-ops-access` 步骤，把生成的 `ops-access-session.json` 传给 `nonlocal-run`。`tests/staging/support.mjs`、`tests/pre-release/support.mjs` 与新增的 `tests/staging/test-der-001.test.mjs` / `tests/pre-release/test-der-001.test.mjs` 现在都会通过 Access service token 请求 `/_ops`，而不再把公开 `workers.dev` URL 当作正向控制面证明。与此同时，本轮本地验证还暴露并修复了一个真实 auth bug：`packages/control-plane/src/crypto.mjs` 之前错误要求 Access JWT `sub` 必须非空，这与 Cloudflare service-auth JWT 允许空 `sub`、以 `common_name` / client identity 作为稳定主体的官方语义冲突；对应回归已被 `tests/local/control-plane/control-plane.test.mjs` 锁定。最新 tooling 还进一步去掉了 Access fail-open：workflow 已不再容忍 `nonlocal-prepare-ops-access` 失败，`packages/testing/src/nonlocal.mjs` 也会在 `staging` / `pre-release` readiness 与 suite execution 前强制要求 `MATRIX_REMOTE_OPS_BASE_URL` 与 `MATRIX_REMOTE_OPS_ACCESS_CLIENT_{ID,SECRET}`，因此这两个环境现在不能再在缺失 `ops-access-session` 的情况下继续假跑 `/_ops` coverage。
  该前置条件现已被 current-head attested run 真实收口。GitHub Actions run `23923285726`（created `2026-04-02T21:40:13Z`，updated `2026-04-02T21:45:53Z`，code state `6fc23f493b5a19cfc2ca20993cc0772ee06a8754`）中，`ci-integration`、`staging`、`pre-release` 三个 non-local job 全部成功；其中 `staging` / `pre-release` 的 `Prepare non-local ops Access session`、bounded readiness probe、environment-backed suite、raw bundle upload、R2 upload、attestation generation 与 attestation artifact upload 全部成功。`phase08-evidence-l1-20260402T214017Z-23923285726-1` evidence artifact 随后把 `EVID-DER-001` 真实转为 `pass`，其 provenance 回链到同轮 GitHub Actions run URL 与 R2 immutable object locator，证明 `/_ops/v1/healthz` / `/_ops/v1/rebuilds` 已在真实 Access ingress 下闭环。换言之，`08.04B` 现已完成，`OQ-0004` 也已关闭；但这不等于同轮就已拿到 `EVID-OPS-001` 所需的 pre-release attestation。后续 same-head raw proof 已由 `OQ-0005` 收口 `TEST-OPS-001` 的 rollout-skew contract，而当前 remaining gap 则已转为 `OQ-0006` 下 shared pre-release attestation 仍被 cost gate 阻断。

### 08.04C 收敛 `TEST-OPS-001` rollout-skew attested pre-release closure

- [ ] 把已落地的 `TEST-OPS-001` dual-version orchestration、Worker/DO pairing observability、transport audit chain 与 dedicated canonical suite 推到 pushed-head GitHub Actions attested pre-release rerun 上收口；若 rerun 暴露新的 remote blocker，必须把 blocker 诚实写回正确 artifact。
  Spec refs: `13` `CF-WKR-012`,`CF-WKR-014`,`CF-WKR-028`,`CF-DO-005`,`CF-DO-021`, `42` `REQ-OPS-010`,`REQ-OPS-011`,`REQ-OPS-012`, `43` `TEST-OPS-001`, `44` `EVID-OPS-001`, `OQ-0005`, `OQ-0006`
  产出:
  current-head attested pre-release skew proof，或写入正确 artifact 的 remote blocker。
  完成标准:
  current-head GitHub Actions attested rerun 真实完成 pre-release dual-version start/restore、`tests/pre-release/test-ops-001.test.mjs`、attestation generation 与 `evidence-l1` 消费，使 `TEST-OPS-001` / `EVID-OPS-001` 不再只停留在本地实现态；若 rerun 暴露新的 remote blocker，必须把 blocker 诚实写回对应 artifact。
  当前状态:
  `2026-04-02` 本轮已把 dual-version rollout、explicit version targeting、pairing observability 与 attested payload contract 写入 `42`,`43`,`44`,`23`,`24`,`25`,`26`，因此本项一度从“低于 SR2 的 spec gap”推进到“SR2 已具备、实现/验证待闭环”的状态。随后又根据 Cloudflare 官方 `version_metadata` docs 补了一次 contract 收口：该 binding 只提供 version ID/tag/timestamp，不提供 deployment ID，所以 `IF-OPS-009` 现在必须由 GitHub Actions harness 显式传入 `dual_version_deployment_id`，而不是要求 worker 内部凭空发现它。
  `2026-04-03` 继续核对 Cloudflare 官方 gradual deployment docs 后，又发现这里还不能诚实写成“只差 attested rerun”：官方明确说明 gradual deployment 下每个 Durable Object 的 version assignment 由 deployment percentages 决定，并在同一 deployment 内保持固定；`Cloudflare-Workers-Version-Key` / `Cloudflare-Workers-Version-Overrides` 只控制请求命中的 Worker version，不会改写已经分配给某个 Durable Object 的 version。由此，`42` 与 current worktree 曾接受过的 `baseline=100%`、`candidate=0%` 再配合 version override 的前提被证伪，它最多只能证明 candidate Worker request routing，不能诚实地产生 candidate-side authority。因此，`08.04C` 现在必须先修正 Spec / workflow / rollout probe：dual-version deployment 需给 baseline 与 candidate 都保留非零份额，并对 probe-owned `UserDO` / `RoomDO` 做 bounded sampling，直到真实拿到 baseline-assigned 与 candidate-assigned 两类 authority identities；在这条修复完成前，不得再把本项描述成“contract 已闭合，只差 attested rerun”。
  `2026-04-03` 当前未推送修复 worktree 已进一步补上 `packages/control-plane/src/ops-handler.mjs` 的 `/_ops/v1/rollout-skew/probe`、`.github/workflows/nonlocal-phase08.yml` 的 pre-release dual-version start/restore、`packages/testing/src/nonlocal.mjs` / `packages/testing/src/evidence.mjs` 的 rollout sidecar 与 strict mapping 接线，以及 dedicated canonical `tests/pre-release/test-ops-001.test.mjs`。在 reviewer 继续抓出 workflow fail-open 与 remote execution bug 之后，当前 worktree 先补做了一轮 repair：pre-release attestation 现已被 `Enforce pre-attestation environment gate` 正确挡住，`startPreReleaseGatewayRollout()` 也不再引用未定义 helper，raw bundle 不再在源目录内自读生成。随后 pushed-head rerun `23931328404`（created `2026-04-03T02:39:29Z`，updated `2026-04-03T02:45:32Z`，head `e833ca13d5b35e7eebd2916b20c2492ab197cd91`）先把剩余 remote blocker 收敛成当前-head harness bug，而不是 contract / mapping 缺口：`nonlocal (pre-release)` 的 dual-version start/restore 与 raw bundle 上传都已成功，但 suite 前 deployment identity revalidation 仍按 baseline gateway deployment id 回读，未跟随 `rollout-state.json` 中的 `dual_version_deployment_id`，导致 attestation 继续被 `Enforce environment gate` fail-closed 拦下；同一 run 的 `ci-integration` / `staging` raw logs 还分别记录了 `registerUser(...)` 处 `500 !== 200` 与 abuse-guard 首次 register 处 `429 !== 401`。结合 node test runner 默认会并发执行多个 test file，这些日志更符合“共享 remote 环境上的跨文件并发干扰”而不是 dedicated canonical suite 本身缺口；这是基于 raw log 的工程推断，而不是新的 attested truth。
  更近一轮 pushed-head rerun `23932130160`（created `2026-04-03T03:14:50Z`，updated `2026-04-03T03:19:50Z`，head `21b1e59baf78c7de7410b97baa76940d42e038c0`）进一步证明当前分支还不能诚实宣称 `TEST-OPS-001` 已闭环：`ci-integration` 完整成功并上传 attestation，但 `pre-release` 仍在 `Enforce environment gate` fail-closed 失败且没有 attestation artifact。下载 raw artifacts 后可确认，这次 pre-release blocker 已比 `23931328404` 更窄：workflow 的 dual-version start/restore 均成功，真正失败点是 `runEnvironmentBackedSuite()` 的 `before_readiness` 仍沿用 baseline deployment summary 做 Cloudflare deployment revalidation，尚未像 `before_suite` 一样切到 `rolloutState.dual_version_deployment_id`。同一 run 的 `staging` 还暴露了新的 current-head truth：`TEST-DER-001` 在 `tests/staging/test-der-001.test.mjs:318` 因 `assert.ok(resultIds.includes(messageEventId))` 失败而未能生成 attestation；与更早成功 run `23923285726` 相比，这轮 derived search assertion 只跑了约 `37.8s` 就失败，而成功 run 中同一步耗时约 `159.9s`，更符合“当前 15s eventual-consistency budget 过紧导致的 false negative”而不是已证实的产品语义回归。这是基于 raw log 的工程推断，不是新的 attested pass。
  当前未推送 repair worktree 已据此再补一轮修复：`runEnvironmentBackedSuite()` 现在会在 pre-release rollout 场景下把 `before_readiness` 与 `before_suite` 两次 Cloudflare deployment revalidation 都绑定到 `rolloutState.dual_version_deployment_id`，并继续固定 node runner 为 `--test-concurrency=1`；`tests/staging/test-der-001.test.mjs` 与 `tests/pre-release/test-der-001.test.mjs` 也把 derived search eventual window 扩到 `120 * 500ms` 并补上缺失 event id 的诊断信息。修复后重新执行 `npm run governance:check`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run test:all`、`date -u +%Y%m%dT%H%M%SZ`（得到 `20260403T032833Z`）以及 fail-closed `npm run evidence:l1 -- --timestamp 20260403T032833Z`；结果仍只让 `EVID-GOV-001` 为 `pass`，说明当前本地 evidence gate 没有因这轮 repair 而出现 fail-open。
  更近一轮 current-head rerun `23932691478`（head `d7b5e182f15a4f6f97975bfaedf7ac21c99ad04d`）又把最新真实差距进一步收窄：`nonlocal (pre-release)` 已成功完成 `Start pre-release rollout skew deployment`、suite execution、restore、raw bundle upload 与 provenance write，但 `tests/pre-release/test-ops-001.test.mjs` 在真实 probe 请求上仍返回 `409 !== 200`，导致 `rollout_skew_probe` sidecar 未写出，`Write environment attestation` 被跳过，`Enforce environment gate` 继续 fail-closed。结合同轮 `pre-release.json` 中 `error_message = "Suite artifact parsing failed: rollout_skew_probe sidecar is required when rolloutState is provided"`，当前 blocker 已进一步从“deployment identity revalidation”收敛为“rollout probe 仍使用了被官方 docs 证伪的 DO assignment 假设”。因此，`08.04C` 现在既不能诚实写成“低于 SR2 已经完全消失”，也不能写成“只差 attested rerun”；它仍需要先修正 rollout contract / implementation，再由新的 attested rerun 收口。在新的 current-head GitHub Actions run 真实产出 pre-release attestation 前，`TEST-OPS-001` / `EVID-OPS-001` 继续保持未完成。
  更近一轮 latest pushed-head rerun `23934505894`（created `2026-04-03T04:59:09Z`，updated `2026-04-03T05:07:40Z`，head `c863dcdec761dd4ccb64347244616556aa458145`）继续把 remote blocker 收窄到一个更具体的 current-head probe 误判，而不是新的 spec gap。复核 raw `pre-release.log` / `pre-release.json` 后可确认：pre-release dual-version rollout、suite 入口与 deployment identity 链仍然闭合，但 `/_ops/v1/rollout-skew/probe` 在 seed request `POST /_matrix/client/v3/register` 上因为缺少 `x-matrix-rollout-probe-gateway-version-id` 而直接抛 `409 precondition_failed`，进而让 `rollout_skew_probe` sidecar 缺失并跳过 attestation。按 `23` / `25` / `26` / `43` / `44` 当前 contract，`TEST-OPS-001` 真正需要被严格证明的是最终 observation 请求上的 gateway/authority pairing，而不是 seed/setup 路由是否都回显该 header；因此当前未推送 repair worktree 已把 `packages/control-plane/src/ops-handler.mjs` 改为只对最终 observation 路由继续强制要求并校验该 header，对 `register` / `login` / `createRoom` / `join` 等 seed/setup 路由则改为“缺失可接受、若存在仍必须匹配 requested version”。
  最新 pushed-head rerun `23980399903`（head `5b9ddbd6b2105c170ba807d5e93efdd2df62f85b`）又把 `08.04C` 的 current-head blocker 改写成了更贴近官方文档的事实：`ci-integration` 与 `staging` 继续成功上传 attestation，`pre-release` 也成功完成 dual-version start、suite execution、restore、raw bundle upload、R2 upload 与 provenance write，但 `tests/pre-release/test-ops-001.test.mjs` 在真实 probe 请求上仍返回 `409`，且 raw `pre-release.log` / `pre-release.json` 记录为 `24` 次连续的 `Probe register challenge failed ... {"status":404,"content_type":"text/plain; charset=UTF-8","body":"error code: 1042"}`，随后 `rollout_skew_probe` sidecar 缺失、attestation 被跳过、`Enforce environment gate` fail-closed。
  这轮 run 使得较早围绕 probe-owned identity uniqueness / attempt-local retry 的归因不再站得住：current head 的 `packages/control-plane/src/ops-handler.mjs` 已会在 bounded sampling 窗口内对 setup failure 继续前进到下一个 deterministic seed label，但 `23980399903` 中所有尝试仍在第一跳 `POST /_matrix/client/v3/register` challenge 上拿到同一份 Cloudflare plain-text error page，而不是 Matrix JSON、也不是 login fallback / probe-owned identity collision。结合 `research/sources/cloudflare-workers-limits.md` 与 `research/sources/cloudflare-workers-compatibility-flags.md` 复核后，当前更贴近 failure shape、且受官方 docs 强支撑的主导假设是 same-zone public fetch topology：pushed head `5b9ddbd6b2105c170ba807d5e93efdd2df62f85b` 的 `ops-worker` rollout probe 仍通过 `MATRIX_PUBLIC_BASE_URL` 全局 `fetch()` 同 account `workers.dev` gateway hostname，且当时的 `apps/ops-worker/wrangler.jsonc` / `packages/runtime-core/src/runtime-manifest.mjs` 尚未显式钉住 `global_fetch_strictly_public`。在这条平台约束被推送到新的 current head 并拿到 attested rerun 之前，`08.04C` 仍不得被写成完成。
  `2026-04-04` latest pushed-head rerun 现已更新为 `23980399903`（head `5b9ddbd6b2105c170ba807d5e93efdd2df62f85b`），而这轮 remote artifact 已经把上面两条“uniqueness tail / retry window”解释一起降格为弱假设。下载并复核 current-head `pre-release` raw artifact 后可确认：`tests/pre-release/test-ops-001.test.mjs` 仍被执行，但 rollout probe 的 24 次 `register challenge` seed request 全部收到 `404 text/plain "error code: 1042"`，随后 `rollout_skew_probe` sidecar 缺失、attestation 被 fail-closed 跳过。结合 `research/sources/cloudflare-workers-limits.md` 与 `research/sources/cloudflare-workers-compatibility-flags.md` 的官方事实，这条失败形状强烈指向 current topology 的 same-zone public fetch 约束，但尚未单靠 remote rerun 证明为唯一根因；因此旧的“截断碰撞 / setup retry”归因必须回退成 superseded 状态，而新的 transport repair 仍需 attested rerun 才能闭环。在新的 pushed-head attested rerun 证明这条 transport repair 生效之前，`08.04C` 继续未完成。
  `2026-04-04` pushed head `2e3bde8ee183744192e7a27ae5fc4b77f5f2af89` 已把这条 transport diagnosis 推进成可执行配置、可审计运行时 contract 与 remote canonical gate，而不是只停留在文档推断：`apps/ops-worker/wrangler.jsonc` 与 `packages/runtime-core/src/runtime-manifest.mjs` 现在对 `ops-worker` 显式钉住 `global_fetch_strictly_public`；`packages/runtime-core/src/deployment-records.mjs`、`packages/control-plane/src/ops-handler.mjs`、`packages/control-plane/src/schemas.mjs` 与 `spec/framework/26-wire-schema-catalog.md` 也把 `compatibility_flags` 纳入 deployment record 与 `/_ops/v1/healthz`，使该 worker-specific rollout invariant 可被真实审计，而不是继续藏在 manifest/wrangler 之外；与此同时，dedicated canonical `tests/pre-release/test-ops-001.test.mjs` 也已补上对 `/_ops/v1/healthz.compatibility_flags` 的 fail-closed 断言，使 next pre-release rerun 会直接验证这条 transport repair。对应本地重新执行 `npm run governance:check`、`node --test tests/local/control-plane/phase-08-ops.test.mjs`、`node --test tests/local/runtime-foundations/config.test.mjs`、`node --test tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs`、`node --test tests/local/runtime-foundations/runtime-skeleton.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run test:all`、`date -u +%Y%m%dT%H%M%SZ`（得到 `20260404T143813Z`）以及 fail-closed `npm run evidence:l1 -- --timestamp 20260404T143813Z` 后，结果仍只让 `EVID-GOV-001` 为 `pass`。换言之，这轮 repair 已经补齐 local config/audit gap；但它本身只构成本地 fail-closed 证明，不构成 remote closure；后续 pushed-head rerun 已继续前推到 `23981099390` 与 `23984768921`，其真相必须继续以 raw artifact / evidence artifact 为准回写。
  `2026-04-04` latest reviewed pushed-head run `23986289866`（created `2026-04-04T19:48:07Z`，updated `2026-04-04T19:55:07Z`，head `b6b3789eebf51f853cc5b96f295890e644cef553`）已经把 `08.04C` 的 OPS-specific remote blocker 真实收口到比“attestation 仍缺失”更窄的事实：`local-foundation` 成功，`ci-integration` 与 `staging` 均成功上传 attestation，`pre-release` 也成功完成 Access session、dual-version rollout start/restore、raw bundle upload、R2 upload 与 provenance write。更关键的是，raw `pre-release.log` / `pre-release.json` 明确记录 `TEST-OPS-001` 为 `pass`，`rollout_skew_probe.json` 已真实存在，且 `new_worker_old_authority` / `old_worker_new_authority` 两个 assertions 都为 `true`。这说明 `OQ-0005` 所追踪的 rollout-skew contract / named-environment runtime identity 问题已不再是 active blocker。当前本项 remaining gap 反而变成了 shared pre-release attestation topology：同一 run 的 `TEST-COST-001` 继续按 `OQ-0006` 以 `500/internal` fail-closed，并因为 `pre_release_cost_observation` sidecar 缺失而让 pre-release attestation 被整体跳过。所以 `08.04C` 现在仍不能勾选完成，但它未完成的原因已不再是 `TEST-OPS-001` 语义未闭环，而是 `08.04D` / `OQ-0006` 仍在同一环境 attestation 上形成 shared blocker。

### 08.04D 收敛 `TEST-COST-001` pre-release proof contract prerequisite

- [ ] 先把 `TEST-COST-001` / `EVID-COST-001` 的 pre-release actual-cost proof contract 写成可执行 Spec，再讨论对应 canonical non-local suite。
  Spec refs: `41` `REQ-OPS-003`, `43` `TEST-COST-001`, `44` `EVID-COST-001`, `OQ-0006`, `OQ-0002`
  产出:
  pre-release cost telemetry / export contract、wire/data/interface mapping、对应 workflow / harness / evidence 接线或 blocker。
  完成标准:
  `TEST-COST-001` 的 pre-release half 必须要么真实落地 dedicated canonical suite、official metrics query/normalization、`PreReleaseCostObservation` attestation 与 strict evidence gating，要么把无法继续的 official metrics/permission blocker 写入正确 artifact；不得再以“仅达到 SR2”就把本项写成完成。
  当前状态:
  `2026-04-02` 本轮已把 pre-release half 的 contract 收敛到 `PreReleaseCostObservation`：必须对 bounded workload 的同一 pre-release environment/window 查询 official Cloudflare metrics/billing surfaces，并把 normalized `cost_surfaces` + `model_comparison` attestation 化到 pre-release report 中；`OQ-0006` 也已相应更新，不再把本项描述成“没有 contract”。
  `2026-04-04` current worktree 又把 implementation/suite 继续前推了一步：`tests/pre-release/test-cost-001.test.mjs` 已作为 dedicated canonical suite 落地，`packages/testing/src/evidence.mjs` 已补上 strict `TEST-COST-001 -> pre-release` mapping，`packages/testing/src/nonlocal.mjs` 也已把 `pre_release_cost_observation` sidecar parsing 接入 fail-closed。但在重新核对 Cloudflare 官方资料后，上一版 success-path 不能诚实保留：GraphQL Analytics API 明确声明其 datasets 不应用作 Cloudflare billing usage 真相；Workers metrics 只暴露 sampled quantiles，而不是 billable request / CPU totals；Durable Objects 按 wall-clock duration 计费，但官方 DO GraphQL surface 当前公开的是 `requests`、`cpuTime` 与 `storedBytes`；Billing Usage / PayGo API 则仍是 beta / select-account access，且是 account-scoped service line-item 视图，不是当前 fixed same-account topology 所需的 pre-release environment-scoped视图。因此当前 worktree 现已把 `/_ops/v1/cost/observation` 改为在 `OQ-0006` 下显式 fail-closed，而不是继续输出伪造的 `actual_total_usd` / `modeled_total_usd`。换言之，本项现在的真实 blocker 已不再是 canonical file / mapping，而是缺少一个官方、billing-grade、environment-scoped surface；`OQ-0002` 继续只约束 production monthly snapshot / pricing semantics，不得与本项混写。
  这也把 current-head pre-release gating 结构改写得比此前更严格：`packages/testing/src/bootstrap.mjs` / `packages/testing/src/nonlocal.mjs` 会把 `tests/pre-release/test-cost-001.test.mjs` 自动纳入同一 `pre-release` suite，而 `evidence:l1` 仍只消费单一 `pre_release_run_report` attestation。因此，在没有新的 official surface 或新的 attestation-topology decision 之前，`TEST-COST-001` 已不再只是 `EVID-COST-001` 的孤立 blocker；它会和同环境的 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 共用 current-head pre-release attestation 的成败面。
  `2026-04-04` latest reviewed pushed-head run `23986289866` 已把这条 shared-gate 关系从推断推进成 same-head remote truth：raw `pre-release.log` 中，`TEST-COST-001` 继续以 `500/internal` fail-closed，而 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 都已 `pass`，`rollout_skew_probe.json` 与 rollout restore 也都真实存在；但 `pre-release.json` 仍因 `pre_release_cost_observation sidecar is required when TEST-COST-001 is covered` 直接失败并跳过 attestation。换言之，当前 active pre-release blocker 已经收敛为 cost alone，而不是 “OPS + COST” 并列。
  `2026-04-05` latest reviewed pushed-head run 现已前推到 `24001049145`（created `2026-04-05T11:59:10Z`，updated `2026-04-05T12:08:16Z`，head `ec1b647e55b7fbb571145cc4a3c5acd43beb99b6`），而这轮 same-head raw artifact 继续把 blocker 固定在 `OQ-0006` 所描述的 official surface 缺口上，而不是 mapping / Access / rollout 问题：`ci-integration` 与 `staging` 都成功上传 attestation，`pre-release` 也成功完成 Access session、dual-version rollout start/restore、suite execution、raw bundle upload、R2 upload 与 provenance write；raw `pre-release.log` 明确记录 `TEST-COST-001` 继续以 `500/internal` fail-closed，错误消息仍指向 “current official Cloudflare surfaces do not yet support a truthful actual_total_usd and model_comparison ... see OQ-0006”，同时 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 都为 `pass`，`rollout_skew_probe.json` 也真实存在。但 `pre-release.json` 里的 `pre_release_cost_observation` 仍为 `null`，随后继续以 `Suite artifact parsing failed: pre_release_cost_observation sidecar is required when TEST-COST-001 is covered` fail-closed，attestation 被整体跳过。因此，`08.04D` 当前仍不能完成，而且 remaining blocker 仍然只剩 official billing-grade pre-release cost proof 本身。
  `2026-04-05` latest reviewed pushed-head run with substantive same-head pre-release raw artifacts 现已前推到 `24003512030`（head `700b8600264b78eacc07733a7fd09248d9c68e8a`）；同一 head 上更晚的 rerun `24003585072` 在任何 job / artifact 产出前即被取消，不构成新的审计真相。这轮 `24003512030` 的 same-head raw artifact 继续把 blocker 固定在同一 truthful surface gap 上：`ci-integration` 与 `staging` 继续成功上传 attestation，`pre-release` 也真实完成 bounded readiness probe、suite execution、raw bundle upload、R2 upload 与 provenance write；`TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 继续全部 `pass`，`rollout_skew_probe.json` 仍真实存在，但 `TEST-COST-001` 仍按 `OQ-0006` 以 `500/internal` fail-closed，`pre_release_cost_observation` 继续缺失，随后 `pre-release.json` 仍以 `Suite artifact parsing failed: pre_release_cost_observation sidecar is required when TEST-COST-001 is covered` 结束。因此，`08.04D` 的 active blocker 仍然只剩 official billing-grade pre-release cost proof 本身。

### 08.04E 建立 `TEST-E2E-001` / `EVID-E2E-001` 的真实浏览器 mandatory gate

- [x] 用 `Playwright + pinned Element Web release` 建立真实浏览器 non-local gate，并把其 journey coverage / evidence sidecar 接入当前 `staging` attestation 链。
  Spec refs: `12` 9, `26` 5.16, `43` `TEST-E2E-001`, `44` `EVID-E2E-001`
  产出:
  `TEST-E2E-001` / `EVID-E2E-001` 对应 Spec/TODO、browser journey coverage sidecar schema、testing/evidence wiring、Playwright + Element harness、staging canonical suite、GitHub Actions 安装与执行链、local companion contract tests。
  完成标准:
  pinned official Element Web bundle 会在 GitHub Actions staging environment-backed run 中被真实加载，`tests/staging/test-e2e-001*.test.mjs` 通过真实 Chromium 覆盖 canonical journey matrix，产出 attested `browser_journey_coverage` sidecar，并满足 `coverage_ratio >= 0.80` 且全部 `P0` journeys 为 `pass`；`evidence:l1` 也必须把 `EVID-E2E-001` 诚实纳入 `L1` gate。若 staging attestation 缺 sidecar、coverage 低于阈值、或 secure backup / device verification / 历史解密等 `P0` journey 任一失败，则本项保持未完成。
  当前状态:
  `2026-04-07` 当前工作已从 `phase08-nonlocal-closure` 切出实现分支 `phase08-element-e2e` 开始执行。既有 `CS/ROOM/MEDIA/DER/SEC` non-local attestation 不能代替本项 closure，因为它们证明的是 API/protocol/derived truth，不是 pinned Element Web 上的真实 browser usability。当前 browser gate 仍未闭环，必须以新的 staging attested run 为准。
  `2026-04-08` current branch 已把测试层最主要的假阴性进一步收紧：DM journey 现在会等待真实的 DM compose/open path，并且 `sendMessage()` 不再把 local echo 误记为成功，而是必须看到 Matrix `/_matrix/client/*/rooms/{roomId}/send/m.room.(message|encrypted)/{txnId}` 的 `200` 接受后才算消息真正发出。same-head prod-backed rerun `rerun34` 因而把 active browser blocker 收敛成一个更具体、可重复的真实行为：`E2E-JRY-007` 中 Alice 侧 DM 建立、invite、Bob join、以及 Alice -> Bob 的后续消息都能成立，但 Bob -> Alice reply 没有拿到 `/send` 接受，Element UI 明确显示 `Some of your messages have not been sent` / `Failed to send`，raw body artifact 还包含 `Encrypted by a device not verified by its owner.`。同轮 browser journey coverage sidecar 记录 `passed_journeys = 11/15`、`coverage_ratio = 0.7333333333333333`、`required_pass_ratio = 0.9166666666666666`，唯一 `P0` blocker 仍是 `E2E-JRY-007`；`JRY-004`,`JRY-005`,`JRY-015` 已在这轮 same-head run 中通过并留下 artifact。因此，`08.04E` 当前 remaining blocker 已不再是此前的 invite/timing 假阴性，而是 pinned Element Web + current prod homeserver 上的真实 DM reply send failure；在这条行为被产品/Spec 侧解释并闭环前，本项必须继续保持未完成。该 narrower same-head picture 已被下文 `2026-04-08T13:08:49Z` 的 direct prod-backed rerun 覆盖，不能再当作最新 deployed-environment 真相。
  `2026-04-08` current branch 随后又把 `JRY-007` 的“房间已进入加密态”判定从整页模糊文案进一步收紧到当前 room composer 的可见状态与 failure sidecar：same-head prod-backed rerun `rerun36` 现在不再等到 Bob `/send` 超时才失败，而是更早在当前 DM room 的用户可见状态上 fail-closed。新 artifact 同时证明，同一个 room URL 下 Alice 侧 composer 为 `Send a message…` 且 body 含 `Encryption enabled`，而 Bob 侧 composer 稳定为 `Send an unencrypted message…` 且 body 含 `Messages in this room are not end-to-end encrypted`；也就是说，测试层现在已经把 blocker 钉到房间级真实 UI 状态，而不是全局 body 假阳性。随后同一 head 的 `rerun37` 再次得到完全一致的 `JRY-007` 失败形态与 `11/15` coverage summary，说明当前 browser test layer 已经从“可能乱报”收敛成“稳定暴露同一个真实 DM 加密 blocker”。同日的 `rerun38` 还进一步把 failure artifact 收紧到双方当前 `room_id`：Alice 与 Bob 在失败时都位于同一 `#/room/!kI6hUsTQKKSSuD5CHmmjk3kYZv_ETpHHLLaa_1uU7JE`，同时 Alice 侧仍显示加密 composer / banner，而 Bob 侧仍显示未加密 composer / banner，从而把“打开错房间”这类测试层解释进一步压缩。三轮 sidecar 都继续记录 `coverage_ratio = 0.7333333333333333`、`required_pass_ratio = 0.9166666666666666`，其余 `P0` journeys 仍全部通过，因此当前 remaining blocker 依旧只剩 `E2E-JRY-007` 本身，而不是浏览器 harness 漂移。
  `2026-04-08` 当前修复分支 `fix/jry-007-dm-encryption-state` 已把产品侧诊断推进到 `/sync` join 投影本身：`packages/runtime-core/src/durable-objects.mjs` 现在对 `invite/knock/non-joined -> join` 的真实迁移回填 bounded recent visible timeline slice，并把 backfill 收紧到目标用户在当前 `m.room.history_visibility` 下真实可见的 recent context，而不是房间全局 timeline；`apps/gateway-worker/src/index.mjs` 与 `RoomDO.projectForSync()` 也同步把 timeline limit 的 join-path 语义补齐为“保留 causal `m.room.member join` 事件且保持连续后缀”，避免 `/sync` 最终截断把 join 事件重新挤掉。`spec/framework/30-client-identity-and-sync.md` 相应把这条 join backfill / visibility cutoff / `limited` / `prev_batch` 语义写成规范；`tests/local/client-identity/phase-05a.test.mjs` 也新增 DM 回归与 join-boundary 回归，锁定 `use_state_after` 下新加入用户必须同时看到当前加密 state、recent visible room context、`joined` history visibility 不泄露 pre-join message history，以及 join backfill 被截断时的 truthful `limited + prev_batch + retained join event`。对应本地重新执行 `npm run governance:check`、`node --test tests/local/client-identity/phase-05.test.mjs`、`node --test tests/local/client-identity/phase-05a.test.mjs`、`node --test tests/local/client-identity/phase-06.test.mjs`、`node --test tests/local/runtime-foundations/browser-e2e.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs` 均为 `pass`。但这轮修复尚未得到 same-head deployed-environment 证明：当前 shell 缺少 Cloudflare deploy 凭据，`npx wrangler whoami` 明确返回 `You are not authenticated. Please run \`wrangler login\`.`，因此无法把本地修复部署后再跑真正的 same-head remote rerun。
  `2026-04-08T13:08:49Z` 随后直接针对当前 deployed prod URL `https://matrix-gateway-worker-prod.yevdndjyebksug.workers.dev` 重跑一次 prod-backed `TEST-E2E-001`，结果表明 deployed-environment 真相已经不再收敛到 `rerun38` 那组“只剩 `JRY-007`”的 narrower picture：新 `browser-journey-coverage` sidecar 记录 `passed_required_journeys = 5/12`、`coverage_ratio = 0.3333333333333333`，并且 `E2E-JRY-004`,`E2E-JRY-005`,`E2E-JRY-007`,`E2E-JRY-008`,`E2E-JRY-009`,`E2E-JRY-013`,`E2E-JRY-015` 现在都为 `fail`。其中 `JRY-013` 的 notes 还捕获到同一 private-room path 上出现 `You can't see earlier messages` / `You don't have permission to view messages from before you were invited` 与 `Messages in this room are not end-to-end encrypted` 的 deployed-prod UI 状态。换言之，当前本地代码已经收敛出一个 honest 产品修复方向，但 `08.04E` 仍然不能宣称 closure：same-head remote verification 尚未完成，而最新 deployed prod-backed evidence 也已经发生了比 `rerun36/37/38` 更宽的 drift。
  `2026-04-09` current branch latest exact-head GitHub Actions run 已前推到 `24169756988`（created `2026-04-09T02:49:25Z`，updated `2026-04-09T03:00:13Z`，head `90eb630207a61dd95a14c2a3e08e4b10b1f4b639`），而这轮 same-head remote truth 已把上面所有 “尚未 same-head 收口” 的叙述改写为历史状态：`staging` raw suite 为 `pass`，attested `browser_journey_coverage` 真实记录 `coverage_ratio = 0.8`、`passed_required_journeys = 12/12`、`required_pass_ratio = 1`，全部 `P0` journeys 为 `pass`；同轮 `evidence-l1` 中 `EVID-E2E-001` 也已真实转为 `pass`。与此同时，本地 companion/browser-harness 回归继续保持闭合：`npm run governance:check`、`node --test tests/local/runtime-foundations/browser-e2e.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs` 与 `node --test tests/integration/test-cs-004.test.mjs tests/staging/test-cs-004.test.mjs` 均已通过。因此，`08.04E` 现已完成；current branch 的 remaining non-local blocker 已不再是浏览器 gate，而是下文 `08.04D` / `08.05` 所述 cost-only gates。

### 08.04 完成 L1 测试

- [ ] 落地 `TEST-GOV-001`,`TEST-CS-001`,`TEST-CS-002`,`TEST-CS-003`,`TEST-CS-004`,`TEST-ROOM-001`,`TEST-ROOM-002`,`TEST-MEDIA-001`,`TEST-DER-001`,`TEST-E2E-001`,`TEST-SEC-001`,`TEST-OPS-001`,`TEST-COST-001`。
  Spec refs: `43` 3, 5, 9
  产出:
  local / CI / staging / pre-release dedicated 测试套件。
  完成标准:
  `L1` mandatory tests 全部可运行，且所有 non-local gate 项都由 dedicated environment-backed `ci-integration` / `staging` / `pre-release` harness 直接驱动，而不是薄 local shim；其中 `TEST-E2E-001` 还必须真实消费 pinned Element Web browser journey gate，而不是把 API suite 结果便利性复用为“浏览器已覆盖”。
  当前状态:
  `tests/integration/l1-mandatory.test.mjs`、`tests/staging/l1-mandatory.test.mjs`、`tests/pre-release/l1-mandatory.test.mjs` 已改成 dedicated remote harness，直接驱动部署后的 HTTP surface，并通过 `packages/testing/src/evidence.mjs` 的 parser 复核为 environment-backed；`packages/testing/src/nonlocal.mjs` 与 `.github/workflows/nonlocal-phase08.yml` 也已补上 Cloudflare 资源 ensure、环境 deploy、R2 artifact upload 与 GitHub Actions non-local 入口，因此 `08.04` 已不再停留在“薄 local shim”阶段。run `23869349481`（code state `ef3665d77a98b6cc7398d3a6fa5df51a44dbc4cb`）仍是“non-local deploy / upload / attestation 基础链路可工作”的有效证明：该 run 的 `ci-integration`、`staging`、`pre-release` 三环境都成功部署、通过 bounded readiness probe、执行 environment-backed suite、上传 raw bundle 到 R2，并生成有效 `EnvironmentRunAttestation`。但它已不是当前分支代码状态的最新验证。较早的一次失败尝试 run `23879497392`（code state `00b497d2c8205c57f81f97d8c1dcd1b8a03f132f`）中，`staging` 与 `pre-release` 都在 `TEST-MEDIA-001` 失败，并且 raw log 明确记录媒体下载断言把期望的 `GIF89a-phase08-media-body` 读成了 `'[object ReadableStream]'`；因此该 run 不能产出这两个环境的有效 attestation，也不能被写成“当前代码状态已有 attested pass”。当前工作树已本地修复 gateway 对 `ReadableStream` 的错误字符串化，并把 stream-body 上传/下载覆盖补入 `tests/staging/test-media-001.test.mjs` 与 `tests/pre-release/test-media-001.test.mjs`，但在新的 GitHub Actions attested run 出来之前，这些修复仍只能算待验证状态。与此同时，parser 仍会对 template-literal dynamic import 等隐藏依赖 fail-closed，non-local deploy/run/upload/attest primitives 也会要求 GitHub-signed Actions OIDC job identity，并按 dedicated environment 全局串行 workflow / fresh deployment identity / 当前 account workers.dev subdomain / 当前 active deployment-version identity 回读复核，避免仅靠本地伪造 `GITHUB_ACTIONS=true`、跨 ref 争用环境、或篡改 deployment JSON 就假装产出 non-local gate 结果。  
  run `23880866545`（timestamp `2026-04-02T02:32:34Z`，code state `0d449928209f6f2098b5f4f8a64d6d5442eb9926`）现已取代 `23879497392` 成为当时该分支上“最近一轮成功拿到三份环境 attestation、且完整执行到 evidence-l1”的可审计基线：`EVID-CS-001`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001` 已在该 run 中拿到 attested pass，说明 dedicated non-local suite + strict mapping 已经真实驱动到对应 remote surface；`EVID-CS-002`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 则继续 fail-closed，其中 `TEST-SEC-001` 当时仍因缺 canonical mapping 而失败。换言之，`23879497392` 里媒体路径的 `'[object ReadableStream]'` 回归已经被后续 `23880866545` 的 attested run 取代，不能再把它写成“最新 attested code state”；但 `23880866545` 也同样不是后续未提交修复 worktree 的验证结果。
  截至 `2026-04-02T11:40:00Z` 复核，最新 pushed head 的 GitHub Actions run 已更新为 `23896874672`（created `2026-04-02T10:51:29Z`，updated `2026-04-02T10:55:54Z`，code state `584fd075e9089538cf368854118a43225d063590`）：`ci-integration` 与 `pre-release` 成功完成 deploy、environment-backed suite、R2 upload、attestation generation，并分别上传 `phase08-ci-integration-attestation-20260402T105133Z-23896874672-1` 与 `phase08-pre-release-attestation-20260402T105133Z-23896874672-1` artifact；`staging` 虽也执行到 deploy、suite、raw bundle upload、R2 upload、attestation generation，但仍在 `Enforce environment gate` 失败并跳过 attestation artifact upload。对应 `gh run view 23896874672 --json jobs,url` 与 `gh api repos/VrianCao/MatrixFlare/actions/runs/23896874672/artifacts` 已确认该 run 只有 `ci-integration` / `pre-release` attestation artifact、`staging` raw artifact，以及 `phase08-evidence-l1-20260402T105133Z-23896874672-1` evidence artifact；因此它仍不能被写成“当时的 pushed head 已具备 staging attested pass”，而只能被写成“当时的 pushed head 已进一步拿到 `ci-integration` / `pre-release` attestation，但 `08.04` / `08.05` 仍未闭环”。
  本轮除了前述 `TEST-SEC-001` suite/mapping 收敛外，还修复了一个真实本地回归：`tests/staging/support.mjs` / `tests/pre-release/support.mjs` 对“显式 non-local 环境但缺 remote base URL”继续保持 fail-closed，但 `packages/testing/src/cli.mjs all` 现在会显式标记 aggregate local run，使 `npm run test:all` 重新回到“本地聚合矩阵可诚实 skip 非本地 suite、显式 non-local 选择仍 fail-closed”的状态；`tests/local/runtime-foundations/testing-harness.test.mjs` 也已补上对应回归测试。因此，本地 regression matrix 再次可作为 honest local gate，但这并不等于 non-local evidence 已闭合。
  随后的 non-local 尝试已把 `TEST-SEC-001` 的真实远程 blocker 暴露出来：`staging` / `pre-release` 在 run `23882982493` 的 raw bundle 中都失败于 `tests/*/test-sec-001.test.mjs:280` 对 `GET /_matrix/client/v3/publicRooms?limit=1` 的 baseline abuse-guard 断言，其中 `staging` 实际返回 `200`、`pre-release` 实际返回 `503`，而不是期望的 `429`。该结果证明此前 `gateway-worker` 的 coarse guard 仍依赖 isolate-local `Map`，在 Cloudflare non-local 环境下不能稳定形成同一环境内的真实护栏。该分支随后已据此把该路径推进为更贴合平台事实的实现：新增官方快照 `research/sources/cloudflare-workers-rate-limit.md`，把 `CF-WKR-027` 回写到 `13` / `15` / `40`，将 `packages/runtime-core/src/abuse-guard.mjs` 改为优先走 Workers `ratelimits` binding；仅在本地/非 release-gate 场景且 binding 缺失时才回退本地 `Map`，而 `ci-integration`、`staging`、`pre-release` 以及其他非本地环境名一旦缺 binding 就直接 fail-closed。`packages/testing/src/nonlocal.mjs` 也会为这三个环境重写独立 rate-limit `namespace_id`，并在 readiness 前与 suite 前通过 Cloudflare 当前脚本 settings 回读复核实际绑定的 `ratelimit_namespaces`；校验现已要求 `gateway-worker` 自身持有完整 namespace 集合，且非 gateway worker 不得冒带这些 binding，从而避免跨环境或跨 worker 污染被 union 掩盖。对应本地 targeted gates `node --test tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run test:all` 与 `npm run governance:check` 现已重新通过。基于第一版 bounded-window suite 修正触发的 run `23900572856`（head `0cfa250fbb20cab31c1a34c811f55983750986aa`）随后又被 reviewer 证实仍存在证明缺口：若 `search` 先返回 `429`，旧 suite 会在同一步跳过 `publicRooms` 请求，因此不能被当作 shared search/publicRooms limiter 的完整证明。当时的 pushed head `daaf22b32d5d3e0eaa9c993a66b8c7561e9f4e70` 已去掉该 early-break，并由新的 GitHub Actions run `23900855087`（created `2026-04-02T12:41:00Z`，updated `2026-04-02T12:44:02Z`）完成第一轮修复后 attested rerun：`ci-integration`、`staging`、`pre-release` 三个 non-local job 全部成功完成 deploy、environment-backed suite、R2 upload、attestation generation 与 artifact upload，`gh api repos/VrianCao/MatrixFlare/actions/runs/23900855087/artifacts` 也已确认存在三份环境 attestation artifact 与 `phase08-evidence-l1-20260402T124104Z-23900855087-1` evidence artifact。
  但本项仍未完成，当前真相已进一步收敛为四点。其一，`TEST-CS-001`,`TEST-CS-002`,`TEST-CS-003`,`TEST-CS-004`,`TEST-ROOM-001`,`TEST-ROOM-002`,`TEST-MEDIA-001`,`TEST-SEC-001` 已在 pushed-head attested runs 上拿到 `pass`，不再受“缺同轮 attestation”阻塞。其二，run `23923285726` 曾真实证明 `TEST-DER-001` 可以由 dedicated staging / pre-release canonical suites 闭环；更近一轮 latest pushed-head rerun `23932691478`（head `d7b5e182f15a4f6f97975bfaedf7ac21c99ad04d`）中，`staging` 已重新成功上传 attestation，而 `pre-release` raw artifact 也显示 `TEST-DER-001` 本身已执行通过，说明当前最新硬 blocker 不是 dedicated DER suite 语义回归，而是同轮 pre-release attestation 被 `TEST-OPS-001` 阻断后，`EVID-DER-001` 仍无法对 current head 收口。其三，`TEST-OPS-001` 已不再低于 `SR2`：current worktree 已补上 dedicated canonical suite、workflow orchestration、probe route 与 strict evidence mapping，并已通过本地 fail-closed 验证；但 `23932691478` 进一步证明 current head 的 pre-release blocker 已收敛为 rollout probe contract / implementation 本身，而不是缺 mapping 或单纯缺 rerun，因此 `08.04C` 继续未完成。其四，`TEST-COST-001` 仍继续受 `OQ-0006` 与 `OQ-0002` 约束，既缺 official metrics/billing access 闭环，也缺 production monthly snapshot。换言之，`08.04` 现在未完成的根因不再是 non-local Access topology，也不再是“最新 pushed head 已证实的 DER suite 回归”；剩余根因是 current-head pre-release rollout-skew proof 尚未 attested 收口，以及真实 cost proof 仍未闭环。在这些 blocker 收口前，仍不能把 `08.04` 标成完成。
  `2026-04-04` 最新 pushed-head rerun 现已更新为 `23980399903`（head `5b9ddbd6b2105c170ba807d5e93efdd2df62f85b`）。这轮远端真相说明 `08.04` 的 active pre-release blockers 仍是 `OPS + COST`，但 `OPS` 的最强支撑解释已经从 earlier probe-owned identity 猜测转向 same-zone fetch/platform-topology gap：`ci-integration` / `staging` 已成功上传 attestation，`pre-release` 的 dual-version rollout / suite / restore / provenance 主链路也已闭合，`tests/pre-release/test-cost-001.test.mjs` 也已在同轮 run 中真实执行并按 `OQ-0006` fail-closed；然而 rollout probe 仍在第一跳 `register` challenge 上拿到 `24x` Cloudflare `error code: 1042` plain-text error page，导致 `rollout_skew_probe` sidecar 与 pre-release attestation 继续缺失。因而，在 current head 把这条官方-doc-backed transport hypothesis 修正到 spec + wrangler/runtime manifest 并拿到新的 attested rerun 前，`08.04` 的未完成根因仍然是 `TEST-OPS-001` / `EVID-OPS-001` 尚未对 repaired head 收口，以及 `TEST-COST-001` / `EVID-COST-001` 仍未闭环。
  `2026-04-04` current worktree 还把 latest truth 再推进了一步：`TEST-COST-001` 已不再只是“缺 canonical suite / mapping”的潜在项，而是一个真实会进入 `pre-release` suite 的 dedicated canonical gate；与此同时，`/_ops/v1/cost/observation` 也已按 `OQ-0006` 改为显式 fail-closed。由于当前 workflow / evidence 仍只消费单一 `pre_release_run_report`，这意味着下一轮 current-head rerun 已不能再被表述成“只要先恢复 OPS attestation，再观察 DER/OPS 是否收口”。更贴近当前代码状态的 truth 是：`TEST-OPS-001` 与 `TEST-COST-001` 现在都是 active pre-release blockers；即使 rollout probe repair 让 `TEST-OPS-001` 通过，未解决的 cost proof 也会继续把同一 pre-release attestation 挡住，并连带使 `EVID-DER-001` / `EVID-OPS-001` / `EVID-COST-001` 继续不能在 current head 上诚实转为 `pass`。在这两个 blocker 中至少还剩其一未收口时，`08.04` 仍不得被写成完成。
  `2026-04-04` latest reviewed pushed-head run that reached relevant pre-release OPS/COST truth 现已前推到 `23984768921`（head `326e5d886ce615424d4fac8fc5e592cc985e84ef`）。这轮 artifact 证明 `08.04` 的 active pre-release blockers 仍然是 `OPS + COST`，而且 `OPS` 的 remote failure shape 又被 current-head raw artifact 改写得更具体：`ci-integration` 与 `staging` 继续成功上传 attestation，`pre-release` 也真实执行了 dedicated `tests/pre-release/test-cost-001.test.mjs`、`tests/pre-release/test-der-001.test.mjs`、`tests/pre-release/test-media-001.test.mjs`、`tests/pre-release/test-ops-001.test.mjs`、`tests/pre-release/test-sec-001.test.mjs`；其中 `TEST-DER-001`、`TEST-MEDIA-001`、`TEST-SEC-001` 在 raw suite 中已通过，`TEST-COST-001` 继续按 `OQ-0006` 以 `500/internal` fail-closed，而 `TEST-OPS-001` 则在 baseline seeding 阶段始终没有拿到 Cloudflare-official runtime identity，只观测到 repo-local fallback `gha-pre-release-...-gateway-worker` 与 `pending-runtime-version-...`，后续 bounded sampling 又连续命中 `429 M_LIMIT_EXCEEDED` / `retry_after_ms=60000`；因此 `rollout_skew_probe` sidecar 缺失，pre-release attestation 被跳过。换言之，当前 `08.04` 未完成的根因仍然是：latest relevant pre-release truth 仍显示 pushed head 尚未在 named-environment-scoped `version_metadata` 路径上闭合 `TEST-OPS-001` 的 official runtime identity contract，而 `TEST-COST-001` 也仍缺 official billing-grade environment-scoped proof surface。
  `2026-04-04` 此前 pushed head `36f437764c7638c27303c4d0e243df5bad973101` 已把这两类 current-head code issue 往前推了一步，但这些已推送 repair 仍未拿到新的 non-local artifact 收口：`packages/testing/src/nonlocal.mjs` 现会把 generated `version_metadata` binding 写入 `env.<name>.version_metadata` 以匹配 Cloudflare named environment 行为；`packages/control-plane/src/ops-handler.mjs` 则在 rollout probe 收到 `retry_after_ms` 时立即 fail-closed 停止 bounded sampling，并把这一早停行为覆盖到 register/login/createRoom/join 等 setup path；`packages/testing/src/evidence.mjs` 也已收紧 same-run / same-attempt 与 pre-release rollout provenance 校验。由于 `23985777845` 在 `local-foundation` 先失败并跳过 `nonlocal`，这些已推送 repair 现在仍只是待 rerun 验证的代码状态，不得当作 remote closure；在新的 pushed-head GitHub Actions rerun 真实证明它们生效之前，`08.04` 仍不得标成完成。
  `2026-04-04` latest reviewed pushed-head rerun 现又前推到 `23985777845`（created `2026-04-04T19:17:59Z`，updated `2026-04-04T19:18:47Z`，head `36f437764c7638c27303c4d0e243df5bad973101`），但这次最新真相不是新的 pre-release raw artifact，而是同一 pushed head 在 handoff CI 上先回退了一步：`local-foundation` job `69957402539` 的 `Runtime harness parser tests` 失败，`nonlocal` job 整体被跳过，GitHub 端只产出 `phase08-evidence-l1-20260404T191803Z-23985777845-1` artifact。复核该 job 日志并以 `GITHUB_REPOSITORY=VrianCao/MatrixFlare node --test tests/local/runtime-foundations/testing-harness.test.mjs` 本地复现后可确认，失败根因不是 `packages/testing/src/evidence.mjs` 的 repo-bound provenance gate 需要回退，而是 `tests/local/runtime-foundations/testing-harness.test.mjs` 多组 attestation fixture 仍把默认 `origin_repository` / GitHub run URL 写死为 `example/matrix`，导致 CI 环境下新的 `origin_repository` 校验先于原本欲覆盖的 harness/proof rejection path 触发。当前未推送 repair worktree 已把这些 fixture 改为默认跟随 ambient `GITHUB_REPOSITORY`（fallback `example/matrix`），并重新执行 `npm run governance:check`、`node --test tests/local/control-plane/phase-08-ops.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run test:all`、`date -u +%Y%m%dT%H%M%SZ`（得到 `20260404T192323Z`）以及 fail-closed `npm run evidence:l1 -- --timestamp 20260404T192323Z`；结果仍只让 `EVID-GOV-001` 为 `pass`。这说明当前 repair 恢复的是 same-head CI handoff honesty，而不是 non-local closure；在新的 pushed-head rerun 真正进入 pre-release non-local 流程前，`08.04C` 仍未完成。
  `2026-04-04` latest reviewed pushed-head run 现已前推到 `23986289866`（created `2026-04-04T19:48:07Z`，updated `2026-04-04T19:55:07Z`，head `b6b3789eebf51f853cc5b96f295890e644cef553`）。这轮 run 先真实证明此前 `23985777845` 的 handoff regression 已被修复：`local-foundation` 的 `Runtime harness parser tests`、`Non-local tooling tests` 与 local regression matrix 全部成功，workflow 重新进入三环境 non-local path。
  同一 run 也把 `08.04` 的 active remote blocker 从 `OPS + COST` 并列进一步收窄成了 `COST` alone：`ci-integration` 与 `staging` 都成功上传 attestation，`pre-release` 成功完成 dual-version rollout start/restore、raw bundle upload、R2 upload 与 provenance write；raw `pre-release.log` / `pre-release.json` 还明确记录 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 全部 `pass`，并已真实产出 `rollout_skew_probe.json`。但 `TEST-COST-001` 继续按 `OQ-0006` 以 `500/internal` fail-closed，随后 `pre-release.json` 以 `Suite artifact parsing failed: pre_release_cost_observation sidecar is required when TEST-COST-001 is covered` 结束，导致 pre-release attestation 被跳过。换言之，当前 `08.04` 仍未完成，但 remaining blocker 已不再是 DER/OPS dedicated non-local coverage 缺口，也不再是 rollout-skew contract 未闭环；真正剩下的是 official billing-grade pre-release cost proof 与其 shared pre-release attestation gate。
  `2026-04-05` latest reviewed pushed-head run 现已再次前推到 `24001049145`（created `2026-04-05T11:59:10Z`，updated `2026-04-05T12:08:16Z`，head `ec1b647e55b7fbb571145cc4a3c5acd43beb99b6`），而这轮 same-head raw artifact 继续证明 `08.04` 的 remaining blocker 仍是 `COST` alone：`ci-integration` 与 `staging` attestation artifact 真实存在，`pre-release` 也真实执行了 dedicated `tests/pre-release/test-cost-001.test.mjs`、`tests/pre-release/test-der-001.test.mjs`、`tests/pre-release/test-media-001.test.mjs`、`tests/pre-release/test-ops-001.test.mjs`、`tests/pre-release/test-sec-001.test.mjs`；其中 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 全部 `pass`，`rollout_skew_probe.json` 也真实存在，但 `TEST-COST-001` 继续按 `OQ-0006` fail-closed，`pre_release_cost_observation` 仍缺失，pre-release attestation 被整体跳过。因此，当前 `08.04` 仍未完成，但 active blocker 已继续稳定为 official billing-grade pre-release cost proof 本身，而不是 DER/OPS dedicated non-local coverage 回退。
  `2026-04-05` latest reviewed pushed-head run with substantive same-head pre-release raw artifacts 现已前推到 `24003512030`（head `700b8600264b78eacc07733a7fd09248d9c68e8a`）；同一 head 上更晚的 rerun `24003585072` 在任何 job / artifact 产出前即被取消，不构成新的审计真相。而这轮 `24003512030` 的 same-head raw artifact 继续验证同一结论：`ci-integration` 与 `staging` attestation artifact 真实存在，`pre-release` 也真实执行了同一组 dedicated canonical suites；其中 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 继续全部 `pass`，`rollout_skew_probe.json` 仍真实存在，但 `TEST-COST-001` 仍按 `OQ-0006` fail-closed，`pre_release_cost_observation` 继续缺失，pre-release attestation 被整体跳过。因此，当前 `08.04` 仍未完成，但 active blocker 继续稳定为 official billing-grade pre-release cost proof 本身。
  `2026-04-06` merged-master rerun 进一步把这个 blocker 形状前推到 head `2a948e8175efa3dbd089abdb561f2b98b5283248`：same-head `Nonlocal Phase 08` run `24048353576` 中，earlier prod baseline parser defect 已不再参与 pre-release gate，`TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 继续不是 active blocker，而 `/_ops/v1/cost/observation` 仍按 `OQ-0006` 返回 `500/internal`，`pre_release_cost_observation` 仍缺失，pre-release attestation 继续被整体跳过。这轮 merged-master raw artifact 还暴露出一个次级 honesty 缺口：canonical `tests/pre-release/test-cost-001.test.mjs` 仍把 upstream fail-closed blocker 表现成旧的 `expected 200` success-path 断言。当前 worktree 已把 suite 修正为先验证 `OQ-0006` blocker payload，再以明确 blocker message 终止，同时继续不写 sidecar、不放松 attestation gate；因此 `08.04D` 的 active blocker 仍然只是官方 billing-grade pre-release cost proof 本身，而不是 suite/mapping/Access/OPS drift。
  但上述 `merged-master` 的 cost-only 结论不能覆盖当前分支 `phase08-nonlocal-closure` 的 latest same-head truth。该分支 pushed head `0df89bc91a70a412ed36eec161e4f9597eb4580a` 在 GitHub Actions run `24050404771`（created `2026-04-06T20:45:39Z`）中重新暴露出 multi-blocker 状态：`ci-integration` / `staging` / `pre-release` 全部失败，因此当前 branch 还不能诚实沿用“只剩 COST”叙述。raw artifact 复核已确认三类 current-head code issue：其一，`ci-integration` 的 `tests/integration/test-cs-001.test.mjs` 仍把 Cloudflare public-entry limiter 写成 first-burst/first-path 必须立即 429，且 profile propagation eventual window 过短，导致同轮出现 `Expected anonymous public-entry limiter to yield 429 for /_matrix/client/r0/login` 与 `assert.ok(memberEvent)` failure；其二，`staging` 的 `tests/staging/test-cs-002.test.mjs` 漏导入 `expectMatrixError`，直接抛 `ReferenceError`；其三，`staging` 的 `tests/staging/test-der-001.test.mjs` 仍把 rebuild success window 固定成短轮询，raw log 已记录 job 仍在 `1979/1991`、`queue_delivery_state:"staged"` 时被过早判定失败。`pre-release` 则继续按 `OQ-0006` truthful fail-closed，不代表 branch 上的 `CS/DER` reopen 已消失。
  `2026-04-06` pushed head `63e594a68f0a0a23c21b62abc298fc2e5ec6fe78` 的 GitHub Actions run `24051819997` 仍必须保留为 branch 上 `TEST-CS-001` contract 被证伪的关键审计点，而不能被后续 rerun 直接抹平。该 run 已证明 `tests/staging/test-cs-002.test.mjs` 的 import defect 与 `tests/staging/test-der-001.test.mjs` / `tests/pre-release/test-der-001.test.mjs` 的 rebuild wait defect 不再是 active blocker，raw `staging.log` 真实记录 `TEST-CS-002` 与 `TEST-DER-001` 已 `pass`，raw `pre-release.log` 也继续记录 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 全部 `pass`，而 `TEST-COST-001` 仍按 `OQ-0006` truthful fail-closed。真正新增的真相是 `TEST-CS-001` 的旧 non-local contract 不成立：same-head `ci-integration` / `staging` raw logs 与 direct live probe 一起坐实，bounded window 内只要求出现 live `429 M_LIMIT_EXCEEDED` 与 `200/429` envelope，而不是“每个 alias individually 都要命中 `429`”。因此，`24051819997` 的保留价值是证明 `CF-WKR-027` 下旧 contract/suite 必须修正，而不是证明 branch 永久停留在 multi-blocker。
  针对这条 same-head truth，current branch 已把 `TEST-CS-001` / `EVID-CS-001`、`tests/integration/test-cs-001.test.mjs`、`tests/staging/test-cs-001.test.mjs` 与 companion local runtime-control coverage 同步改写为 honest bounded-window alias-matrix `429` + `200/429` envelope contract，并已经拿到 exact-head rerun。latest reviewed pushed-head truth 现已前推到 head `1188d2563e2775c2156efdab6a4061e6ade70fd6` 的 GitHub Actions run `24054413342`：这轮 run 中 `local-foundation`,`ci-integration`,`staging` 全部成功，`ci-integration` 与 `staging` 真实上传 attestation，而 `pre-release` raw artifact 继续记录 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 全部 `pass`，`TEST-COST-001` 则以显式 `OQ-0006` blocker message fail-closed，`pre_release_cost_observation` 仍缺失，随后 `pre-release.json` 继续以 `Suite artifact parsing failed: pre_release_cost_observation sidecar is required when TEST-COST-001 is covered` 结束并跳过 attestation。换言之，对当前 pushed head 而言，`08.04` 在本分支上已经重新且继续稳定在 cost-only shared gate：DER/OPS/MEDIA/SEC dedicated canonical suites 不再是 active blocker，真正剩下的 non-local gap 只剩 official billing-grade pre-release cost proof 本身。
  这也意味着 earlier “当前 worktree 还没有 same-head rerun” 的表述已经失效，必须回退。当前 pushed head 自身就已经有 `24054413342` 这轮 same-head remote truth；因此 `08.04` 仍不能完成，不是因为 DER/OPS coverage、Access topology、rollout-skew proof 或 CS-001 honesty sync 还没验证，而只是因为 `OQ-0006` 所约束的 official pre-release cost proof 仍未存在。
  `2026-04-09` latest exact-head rerun 现已前推到 `24169756988`（head `90eb630207a61dd95a14c2a3e08e4b10b1f4b639`）。这轮 run 中 `local-foundation`,`ci-integration`,`staging` 全部成功，`TEST-E2E-001` 也已按上文真实转为 `pass`；`TEST-CS-004` 则在 exact-head `ci-integration` / `staging` 上恢复诚实 `pass`，原因不是放松 stub gate，而是 suite 已按 `IF-CS-005` / `TEST-CS-004` 对齐 `GET /login` 在 bounded rate-limit window 内允许 `200` 或 `429` 的真实 contract。与此同时，`pre-release` 仍只因 `pre_release_cost_observation` sidecar 缺失而 fail-closed，`rollout_skew_probe` 继续存在且 `TEST-OPS-001` assertions 仍为 `true`。因此，current branch 的 `08.04` latest same-head truth 已再次稳定为 cost-only shared gate：除 `OQ-0006` / `OQ-0002` 外，`TEST-E2E-001`、`TEST-CS-004` 与其余已 attested dedicated suites 都不再是 active blocker。

### 08.05 完成 L1 证据

### 08.05A 建立 production topology install/promote/rollback automation prerequisite

- [ ] 通过 `DEC-0005` / `DEC-0006` 把 production automation contract 固化到 Spec/TODO，再落 GitHub Actions + CLI/tooling 的 `prod-install` / `release-candidate` / `promote-prod` / `operational-prod-refresh` / `rollback-prod` / `prod-cost-monthly` 基础设施；same-head remote 验证必须证明执行入口真实可用，且 fail-closed 时仍保留 raw blocker artifact。
  Spec refs: `42` 2.1-2.3, `24` `DATA-OPS-014`,`DATA-OPS-015`,`DATA-OPS-016`,`DATA-OPS-017`,`DATA-OPS-018`,`DATA-OPS-019`, `25` `FLOW-OPS-PROD-CANDIDATE`,`FLOW-OPS-PROD-INSTALL`,`FLOW-OPS-PROD-PROMOTE`,`FLOW-OPS-PROD-ROLLBACK`,`FLOW-OPS-PROD-COST-SNAPSHOT`,`STATE-PROD-ROLLOUT`,`STATE-PROD-COST-SNAPSHOT`, `26` 5.17, 5.21-5.27, `41` `REQ-OPS-003`, `43` `TEST-OPS-003`, `44` `EVID-OPS-003`, `13` `CF-WKR-012`,`CF-WKR-014`,`CF-WKR-029`,`CF-WKR-030`, `DEC-0005`, `DEC-0006`, `OQ-0002`, `OQ-0006`, `OQ-0007`
  产出:
  reviewed candidate manifest contract、prod topology bootstrap contract、prod promotion / rollback records、受控 `operational_unblock` refresh contract、对应 workflow/tooling/local tests。
  完成标准:
  仓库中真实存在 `prod-install` / `release-candidate` / `promote-prod` / `operational-prod-refresh` / `rollback-prod` / `prod-cost-monthly` workflow 与对应 CLI/tooling；其中 `promote-prod` 只能消费 `ReleaseCandidateManifest`，`operational-prod-refresh` 只能作为 `DEC-0006` 约束下的 `operational_unblock` 例外路径，`rollback-prod` 只能消费 `ProdPromotionRecord` 中的 rollback handle，`prod-install` 不得在 active prod topology 已存在时继续充当 redeploy bypass，migration-safe promote 不得再复用 bootstrap gateway 路径；若 earlier failed prod automation 已把 live prod 留在 mixed deployment state，则后续 promote/refresh 只允许消费 typed `ProdCurrentStateSnapshot`，并且必须先重新 live revalidate 当前 prod identity 与该 snapshot 的 `current_deployment_identity` 完全一致；若 post-mutation refresh 自身也失败，或 raw blocker 需要证明 canonical `current-production-state.json` 的最终处置结果，则同次 raw blocker artifact 还必须显式携带 typed `ProdCurrentStateDisposition`，记录 canonical path 最终是 `refreshed`、`quarantined`、`removed` 或 `refresh_failed`；仅把文件 quarantine/remove 掉而不留下该 sidecar 不算闭环。并且至少有 same-head GitHub Actions 证明 target account 中的 `matrix-*-prod` topology 已被这些入口真实建立，`release-candidate` / `prod-install` / `promote-prod` / `operational-prod-refresh` / `rollback-prod` / `prod-cost-monthly` fail-closed 时仍留下 raw blocker artifact，或把 remote blocker 诚实写回正确 artifact。
  当前状态:
  截至 pushed head `ec1b647e55b7fbb571145cc4a3c5acd43beb99b6`，production automation 入口本身与其历史 same-head remote runs 已被真实建立，`OQ-0007` 也已关闭。repository default branch `master` 现已真实包含 `.github/workflows/prod-install.yml`、`.github/workflows/release-candidate.yml`、`.github/workflows/promote-prod.yml`、`.github/workflows/operational-prod-refresh.yml`、`.github/workflows/rollback-prod.yml`、`.github/workflows/prod-cost-monthly.yml`，而对应 production automation 路径也已真实拿到 same-head remote runs：`prod-install` success `24000789563`、`release-candidate` fail-closed `24001043537`、`promote-prod` fail-closed `24001065315`、`rollback-prod` fail-closed `24001077197`、`prod-cost-monthly` fail-closed `24000831481`，以及 `operational-prod-refresh` success `24012543786`,`24014469260`,`24019281851`。但这些历史事实只说明入口与 earlier contract 曾经存在，不足以把当前 reopen 后的 full gate 重新标成完成。
  其中，same-head `prod-install` run `24000789563` 的 `prod-install-record.json` 已真实记录 fixed-name production topology：`matrix-gateway-worker-prod`,`matrix-jobs-worker-prod`,`matrix-ops-worker-prod`、workers subdomain `yevdndjyebksug`、Access org domain `matrixflare.cloudflareaccess.com`，以及 Access-protected prod ops URL `https://matrix-ops-worker-prod.yevdndjyebksug.workers.dev`。这说明 production automation 已不再停留在“workflow/CLI 只在本地存在”的阶段，而是 target account 中的 prod topology 已被 same-head automation 真实建立。
  current production cost automation truth 现已同时覆盖 historical merged-master proof 与当前 branch same-head proof。较早的 `master` head `a706c04127a5cd7978b850061c81b3c646220a4e` 在 standalone `prod-cost-monthly` run `24005804747` 中，首先真实证明了 subscriptions fallback：`Resolve closed production billing window` 已从 billing profile 缺字段的情况退回到唯一的 account subscriptions `current_period_end`，并把 `billing-window.json` 写成 `resolution_method = cloudflare-account-subscriptions-current-period-end`、`next_bill_date = 2026-04-29T00:00:00Z`、`from_date = 2026-03-01`、`to_date = 2026-03-29`；同时 `Resolve latest successful prod-install baseline run` / `Download prod install baseline record` 成功，随后 `Capture production cost snapshot` 继续按 fail-closed 语义停止，明确报出 `production cost snapshot requires a closed billing window that starts after prod install date 2026-04-05`。而当前 branch pushed head `1188d2563e2775c2156efdab6a4061e6ade70fd6` 的 exact-head `Nonlocal Phase 08` run `24054413342` 又在 embedded `prod-cost` job 中把这条 subscriptions fallback + prod baseline handoff 复现成了 same-head remote truth。由此，production-side blocker 已不再是“缺可信 billing-cycle anchor”或“当前 branch 尚未拿到 same-head prod-cost proof”，而只是“当前账号还没到 fixed prod topology 的第一个 truthful post-install closed billing period”；但这仍不足以单独支撑 `08.05A` 继续维持完成态，因为本项当前还被新的 prod blocker-artifact repair reopen。
  `2026-04-06` current `master` 的 production automation truth 先前已前推到 head `73cb166f911ea6d192f7d7b8ad5ab3e64fc78775`：same-head `Operational Prod Refresh` run `24042461600` 与 `Promote Prod` run `24042505083` 都已经真实成功走过 `Resolve production baseline input`，而 raw state artifact staging / upload 也都已发生。这说明 `08.05A` 的 active blocker 已不能再诚实表述成“same-head master 尚未证明 baseline normalization / provenance binding 可闭环”。
  但必须把 `promote-prod` 的 then-current 卡点写精确：`24042505083` 的 job UI 中 `Resolve candidate commit sha` 第 `10` 步因为 `continue-on-error` 被标成 `success`，可实际 step log 已明确报出 `ENOENT: no such file or directory, open '.../downloaded/candidate/prod-release-candidate.json'`，final guard 也据此在 raw artifact 保留后 fail-closed 报出 `Resolving candidate commit sha failed after raw state preservation.`；随后 `Run actions/checkout@v4` 与 `Require candidate checkout match` 两步都被 `skipped`。因此，current `73cb166f911ea6d192f7d7b8ad5ab3e64fc78775` 的 same-head `promote-prod` truth 只证明到了 candidate-manifest ingress boundary，还没有覆盖 candidate checkout / manifest-match gate。
  这组 repair 合并前的 `master` head `4b7ac076f53f6e2a1ec16a610453b627d0da6d82` 又把 blocker 往前推进了一步，但真实新增结论只有一条：same-head `Operational Prod Refresh` run `24045788582` 已经真实保留了 typed `state/operational-refresh/current-production-state.json`，而且本地下载该 raw artifact 后可见 `ProdCurrentStateSnapshot.access.protected_ops_url = https://matrix-ops-worker-prod.yevdndjyebksug.workers.dev`，说明 earlier “连 usable current-state snapshot 都没留下”的 blocker 已被 merged-head remote truth 纠正。该 run 的实际失败点不是 snapshot/disposition validator，而是 `Refresh production topology operationally` 步骤本身按 fail-closed 语义报出 `baselineRecord deployment_ids and worker_version_ids do not match the current Cloudflare production deployment state; observed current production state retained at .../state/operational-refresh/current-production-state.json`；随后 final guard 只是在 raw state 已保留后继续报出 `Operational prod refresh failed after raw state preservation.`。因此，`24045788582` 证明的是“pre-mutation drift blocker 已能真实保留 typed current-state snapshot”，而不是“validator 已经把 disposition sidecar 语义跑通”。
  针对 pre-mutation blocker 的 failure-artifact validator repair 现已随 PR `#16` 合并到 `master` head `825222f41775a006bf06103a0776ff96f855e795`：若 raw blocker 仍保留 canonical `current-production-state.json`、不存在 `pre-failure-current-production-state.json`、且该 canonical snapshot 自身通过 typed `ProdCurrentStateSnapshot` 校验，则 `prod-current-state-failure-validate` 允许把它视为诚实的 pre-mutation blocker；一旦出现 quarantine evidence、canonical snapshot 缺失、或 snapshot 自身无效，则依旧必须显式保留 `ProdCurrentStateDisposition` 并继续 fail-closed。`tests/local/runtime-foundations/nonlocal-tooling.test.mjs` 也已补上对应 regression，避免把 stale/malformed snapshot 偷放行。修完这条 validator 以后，current merged head `825222f41775a006bf06103a0776ff96f855e795` 确实先在 same-head `Operational Prod Refresh` run `24046187190` 与 `Promote Prod` run `24046187161`（均 created `2026-04-06T19:01:26Z`）里暴露出更精确的 runtime defect：`Resolve production baseline input` 按 fail-closed 语义报出 `TypeError: legacy prod current state snapshot access must be an object`。但这条 reopen 现在已经被 current merged-master repair 和新的 same-head remote truth 真实关闭：head `2a948e8175efa3dbd089abdb561f2b98b5283248` 的 `Operational Prod Refresh` run `24048353567` 已成功通过 `Resolve production baseline input`、`Refresh production topology operationally` 与 raw/R2 artifact retention，并上传 `r2://matrix-evidence-prod/gha/24048353567/1/prod/20260406T195524Z/prod-promotion-record.json`（sha256 `6638870ce8419b047df547e3f27d0217e1f51aed0f810bddd90ae58a495b0dfc`）。因此，legacy prod baseline normalization defect 已不再是 `08.05A` 的 active blocker；当前 production automation remaining gap 只剩“其他 same-head workflow 是否还需在 repaired merged head 上补 remote proof”，而这条 support-prerequisite 已不应继续混入 `L1` blocker narrative。

- [ ] 生成 `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001`。
  Spec refs: `44` 2.4, 3, 4, 6
  产出:
  对应 `evidence/L1/` 与 `evidence/common/` 证据包，以及可审计的 non-local attestation provenance snapshot。
  完成标准:
  可以诚实声称达到 `L1 Local-Core`。
  当前状态:
  `npm run evidence:l1 -- --timestamp <ts>` 现会同轮生成 `EVID-GOV-001`，并按 bundle 校验 `TEST-ID` 对应的 canonical test file 已被目标环境测试入口覆盖；对 non-local evidence，它现在要求提供 `--ci-integration-attestation <path>` / `--staging-attestation <path>` / `--pre-release-attestation <path>`，且 `EVID-COST-001` 还必须额外提供 `--prod-cost-attestation <path>`。这些路径必须是同轮 run 的 `EnvironmentRunAttestation` / `ProdCostSnapshotAttestation`，而不是原始 report/snapshot JSON；其中 provenance validator 现在会额外 fail-closed 于非 `github-actions` origin、缺失或错误的 `origin_repository`、非该 repository 的 GitHub run URL、非 `r2://bucket/key` artifact locator、`artifact_store_key` 不匹配或未编码同一 `run_id` / `run_attempt` / `source_environment` / `run_timestamp`、`deployment_identity.environment_id` 与 `source_environment` 不一致，以及 `localhost` / loopback 等不可审计 URI。相同 `run_timestamp` 的 evidence 输出目录现在必须原子 fail-closed，不得并发复用；`evidence/common/_test-runs/<ts>/*.json` 这类本地共享运行工件或仍扩展 `tests/local/` 的薄 non-local harness 报告也不再可充作 evidence 输入。按 `DEC-0002` 当前 acceptance model，consumer 现阶段并不要求额外签名体系或在线 GitHub/R2 dereference；当前可审计边界固定为 run identity + deployment identity + immutable artifact reference + digest，任何更强真实性验证都属于后续增强，而不是本项当前 blocker。
  目前仓库已补上 `.github/workflows/nonlocal-phase08.yml` 与对应 non-local tooling，可在 GitHub Actions 中部署 `ci-integration` / `staging` / `pre-release`、上传 raw bundle 到 R2、并按 `DEC-0002` 生成 provenance-ready attestation；workflow 也会在 evidence 阶段消费 `prod-cost-attestation`（若存在），否则继续对 `EVID-COST-001` fail-closed。run `23880866545`（timestamp `20260402T023234Z`）是本分支较早一轮成功拿到三份环境 attestation、且完整执行到 `evidence-l1` 的可审计基线：该 run 的 `evidence-l1` job 在下载三份 attestation 后，已使 `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001` 转为 `pass`，同时继续让 `EVID-CS-002`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 保持 `fail`。这轮失败说明的是 `/sync` notification truth、derived rebuild coverage、安全域 canonical mapping、deploy-skew coverage 与 production cost evidence 仍未闭合，而不是 attestation/provenance contract 缺失。
  截至 `2026-04-02T11:40:00Z` 复核，最新 pushed head 的 non-local 运行记录已更新为 run `23896874672`（head `584fd075e9089538cf368854118a43225d063590`）。该 run 中，`ci-integration` 与 `pre-release` 都拿到了 attestation artifact，`staging` 仅产出 raw artifact 并在 `Enforce environment gate` 失败，`evidence-l1` 则继续失败。通过下载并复核 `phase08-evidence-l1-20260402T105133Z-23896874672-1` artifact，可确认该 pushed head 在 evidence 阶段仍只有 `EVID-GOV-001` 为 `pass`；`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 全部继续 `fail`。也就是说，`23880866545` 仍只是“三环境 attestation 全拿齐并进入 evidence-l1”的基线，而 `23896874672` 只是“当时的 pushed head 已进一步拿到 `ci-integration` / `pre-release` attestation，但 staging 与 evidence gate 仍未闭环”的最新证明。
  在补齐 `research/sources/cloudflare-workers-dev.md`、修正 `CF-NET-007` 与 `spec/open-questions/OQ-0004.md` 里的 active-zone-only 过时前提之后，本轮又针对 `publicRooms` cursor 的 fail-open 问题补做了修复：分页 token 中的 `visible_offset` / legacy `offset` 现在必须是严格非负整数，不能再被 `parseInt()` 以 `"1junk" -> 1` 的方式偷放行；`tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs` 也已补上 malformed cursor 回归覆盖。修复后重新执行了 `node --test tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs`、`node --test tests/local/runtime-foundations/data-plane-storage.test.mjs`、`npm run governance:check`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run test:all`、`date -u +%Y%m%dT%H%M%SZ`（得到 `20260402T121152Z`）以及 fail-closed `npm run evidence:l1 -- --timestamp 20260402T121152Z`。结果再次证明 evidence gate 仍保持诚实：治理检查保持 `PASS`，`phase-08-runtime-controls` 14/14 通过，`data-plane-storage` 13/13 通过，`testing-harness` 183/183 通过，本地 regression matrix 372/372 通过，而 `evidence:l1` 仍按预期只让 `EVID-GOV-001` 为 `pass`。
  在此前的 pushed-head run `23900855087`（head `daaf22b32d5d3e0eaa9c993a66b8c7561e9f4e70`）中，`ci-integration`、`staging`、`pre-release` 三个 non-local job 全部成功完成 deploy、environment-backed suite、R2 upload 与 attestation generation，并分别上传 `phase08-ci-integration-attestation-20260402T124104Z-23900855087-1`、`phase08-staging-attestation-20260402T124104Z-23900855087-1`、`phase08-pre-release-attestation-20260402T124104Z-23900855087-1` artifact；`evidence-l1` 则继续 fail-closed。通过下载并复核 `phase08-evidence-l1-20260402T124104Z-23900855087-1` artifact，可确认该 pushed head 在 evidence 阶段已使 `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-SEC-001` 全部转为 `pass`。其中，`EVID-CS-002` 已不再只是“canonical file 已存在但缺 attestation”，而是被同轮 staging attestation 真实收口；`EVID-SEC-001` 也已由同轮 `staging` / `pre-release` attestation 证明 `tests/staging/test-sec-001.test.mjs` 与 `tests/pre-release/test-sec-001.test.mjs` 的 coverage 为 `covered`。
  此前最近一轮成功完成三环境 attestation 且进入 evidence-l1 的 pushed-head 基线仍是 `23923285726`（created `2026-04-02T21:40:13Z`，updated `2026-04-02T21:45:53Z`，head `6fc23f493b5a19cfc2ca20993cc0772ee06a8754`）。该 run 的 `ci-integration`、`staging`、`pre-release` 三个 non-local job 全部成功完成 deploy、environment-backed suite、R2 upload、attestation generation 与 artifact upload；`evidence-l1` 也成功下载三份 attestation 并完成 evidence bundle 生成，只在最终 fail-closed gate 上诚实失败。下载并复核 `phase08-evidence-l1-20260402T214017Z-23923285726-1` artifact 后，可确认 `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001` 现在都已为 `pass`；其中 `EVID-DER-001` 首次由 current-head staging + pre-release attestation 真实收口。该 pushed head 上的 `EVID-OPS-001` 仍然 `fail`，且失败理由当时确实是“`TEST-OPS-001` 仍缺 canonical implementation mapping”；`EVID-COST-001` 也仍然 `fail`，且失败理由同样已收敛为“pre-release attestation 已有效导入，但 `TEST-COST-001` 仍缺 canonical implementation mapping，且 `prod_cost_snapshot` 仍缺失”，分别受 `OQ-0006` 与 `OQ-0002` 约束。  
  随后 pushed-head rerun `23930798915`（created `2026-04-03T02:15:29Z`，head `b491b55c48e3865ba7bbf375343f5caa24276f0b`）进一步证明 `TEST-OPS-001` 仍未闭环，但失败原因已从“缺 mapping”收敛到两个可复现的当前-head 代码问题：其一，pre-release `Start pre-release rollout skew deployment` 因 `packages/testing/src/nonlocal.mjs` 中未定义的 `sanitizeFileName` 直接抛 `ReferenceError`；其二，workflow `Bundle raw non-local artifacts` 把 `run-bundle.tgz` 写回源目录，导致 `tar: file changed as we read it`。同一 run 还证明前一轮 reviewer/repair 已真实生效：pre-release job 在 `Enforce pre-attestation environment gate` 前确实没有生成 attestation artifact，因此 `EVID-OPS-001` 没有被 fail-open 消费。  
  更近一轮 pushed-head rerun `23931328404`（created `2026-04-03T02:39:29Z`，updated `2026-04-03T02:45:32Z`，head `e833ca13d5b35e7eebd2916b20c2492ab197cd91`）又把 current-head blocker 收敛到新的 harness 执行问题：`ci-integration`、`staging`、`pre-release` 三个 non-local job 都执行到 raw bundle upload / provenance 写入，但均在 `Enforce environment gate` 失败并跳过 attestation artifact upload，`evidence-l1` 随后也只剩 `EVID-GOV-001` 为 `pass`。下载并复核 `phase08-evidence-l1-20260403T023933Z-23931328404-1` artifact 后，可确认 `EVID-DER-001` 与 `EVID-OPS-001` 在这轮失败中都不再是 mapping_error，而是分别缺 `staging` / `pre-release` valid attestation 与 `pre-release` valid attestation；`EVID-COST-001` 则继续同时缺 `TEST-COST-001` pre-release mapping 与 `prod_cost_snapshot`。进一步复核 raw artifacts 后，`nonlocal (pre-release)` 的 dual-version start/restore 已成功，但 suite 前 Cloudflare deployment identity revalidation 仍使用 baseline gateway deployment id，而不是 rollout sidecar 中的 `dual_version_deployment_id`；`ci-integration` / `staging` raw logs 还分别记录了 `registerUser(...)` 处 `500 !== 200` 与 abuse-guard 首次 register 处 `429 !== 401`。后两项更符合共享 remote 环境下多 test-file 并发执行造成的跨套件干扰；这是基于 raw logs 的工程推断，而不是 attested conclusion。  
  `2026-04-03` 当前未推送 repair worktree 先据 `23931328404` 与 `23932130160` 补上第三、四轮修复：`packages/testing/src/nonlocal.mjs` 现会在 pre-release rollout 场景下按 `rolloutState.dual_version_deployment_id` 做 suite 前 Cloudflare revalidation，并把 node runner 固定为 `--test-concurrency=1`；`tests/local/runtime-foundations/nonlocal-tooling.test.mjs` 也新增对这些行为的回归覆盖；`tests/staging/test-der-001.test.mjs` / `tests/pre-release/test-der-001.test.mjs` 则把 derived search eventual window 扩到 `120 * 500ms`。随后 latest pushed-head rerun `23932691478`（head `d7b5e182f15a4f6f97975bfaedf7ac21c99ad04d`）又把 current-head truth 进一步改写为：`ci-integration` 与 `staging` 均成功上传 attestation，`pre-release` 也已成功完成 dual-version start、suite execution、restore 与 raw bundle upload；但 `tests/pre-release/test-ops-001.test.mjs` 在真实 probe 请求上仍返回 `409 !== 200`，导致 `rollout_skew_probe` sidecar 缺失、`Write environment attestation` 被 fail-closed 跳过，`evidence-l1` 因缺少 current-head pre-release attestation 而再次失败。也就是说，最新 pushed-head 的主 blocker 已不再是 `staging` DER regression，而是 pre-release rollout probe contract / implementation 仍未闭环；这同样连带使 `EVID-DER-001` 不能在 current head 上重新转回 `pass`，因为它仍缺同轮 pre-release attestation 输入。
  当前未推送 repair worktree 已据 `23932691478` 再补第五轮修复：`spec/framework/13-cloudflare-platform-constraint-register.md` 新增 `CF-DO-021`，`spec/framework/25-sequence-and-state-machine-catalog.md` / `42` / `OQ-0005` / `TODO.md` 也已把 official-doc-backed gradual deployment 语义写回 contract；`packages/testing/src/nonlocal.mjs` 不再以 `baseline=100%`、`candidate=0%` 启动 pre-release dual-version deployment，而是改为两侧都保留非零份额；`packages/control-plane/src/ops-handler.mjs` 的 rollout probe 则改为 bounded sampling probe-owned `UserDO` / `RoomDO` identities，直到真实拿到 baseline-assigned 与 candidate-assigned authority 后再做 cross-version observation，并修复长 `seed_prefix` 下 probe identity 截断碰撞。随后本轮又把 `evidence:l1` 的 provenance contract 收紧到 repo-bound：`spec/framework/26-wire-schema-catalog.md` / `44` / `DEC-0002` 现已要求 attestation 携带 `origin_repository`，并与 `origin_run_uri` 及当前仓库匹配；`packages/testing/src/evidence.mjs` / `packages/testing/src/cli.mjs` / `tests/local/runtime-foundations/testing-harness.test.mjs` 也已补上对应 fail-closed 实现与回归。对应本地验证现已重新执行 `npm run governance:check`、`node --test tests/local/control-plane/phase-08-ops.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run test:all`、`date -u +%Y%m%dT%H%M%SZ`（得到 `20260403T044034Z`）以及 fail-closed `npm run evidence:l1 -- --timestamp 20260403T044034Z`；结果仍只让 `EVID-GOV-001` 为 `pass`，说明当前本地 evidence gate 没有因这轮 repair 而出现 fail-open。换言之，截至这轮 repair 完成时，`08.05` 的未完成根因暂时收敛为两类：一是还需要把当时的 OPS rollout repair 推到新的 attested rerun 上，真实恢复 current-head pre-release attestation，并随之观察 `EVID-DER-001` / `EVID-OPS-001` 是否收口；二是 `EVID-COST-001` 仍继续受 `OQ-0006` / `OQ-0002` 约束，既缺 pre-release official metrics proof，也缺真实 production monthly cost snapshot。在这两类 blocker 收口前，仍不能诚实声称达到 `L1 Local-Core`。
  latest reviewed pushed-head run that reached relevant pre-release OPS/COST truth `23984768921`（head `326e5d886ce615424d4fac8fc5e592cc985e84ef`）继续证明 `08.05` 仍不能诚实前推，而且当前 evidence 真相已可精确写成：同轮 `evidence-l1` 中，`EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002` 为 `pass`；`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 为 `fail`。其中前四项都不再是 canonical mapping 缺口，而是共享同一个 same-head `pre-release` attestation 缺口；`EVID-COST-001` 还继续额外缺真实 `ProdCostSnapshotAttestation`。
  作为 `23986289866` 这轮 same-head evidence / raw artifact 的历史快照，其 failure shape 确实已收敛为 cost-only gates，而不再要求先单独解决 `OPS`：该 run 中 `TEST-OPS-001` 为 `pass` 且 `rollout_skew_probe.json` 真实存在，因此当时 `EVID-OPS-001` 仍为 `fail` 的原因已经不是 rollout-skew proof 缺失，而是 shared `pre-release` attestation 仍被 `TEST-COST-001` 的 `pre_release_cost_observation` 缺失挡住。该历史 run 的剩余 blocker 只有两条且都与成本相关：`OQ-0006` 下 official billing-grade pre-release cost proof 仍未存在，以及 `OQ-0002` 下真实 `ProdCostSnapshotAttestation` 仍缺失。这个描述只用于保留 `23986289866` 的当时真相，不得覆盖 `2026-04-06` 已 reopen 的 `08.05A` 当前状态。
  `2026-04-04` 此前 pushed head `36f437764c7638c27303c4d0e243df5bad973101` 已进一步补上 named-environment `version_metadata` wiring、`retry_after_ms` 早停与 evidence provenance 收紧；对应本地 fail-closed 验证现已再次重新执行 `node --test tests/local/control-plane/phase-08-ops.test.mjs`、`node --test tests/local/runtime-foundations/nonlocal-tooling.test.mjs`、`node --test tests/local/runtime-foundations/testing-harness.test.mjs`、`npm run governance:check`、`npm run test:all`、`date -u +%Y%m%dT%H%M%SZ`（得到 `20260404T190844Z`）以及 fail-closed `npm run evidence:l1 -- --timestamp 20260404T190844Z`；结果仍只让 `EVID-GOV-001` 为 `pass`，说明这轮已推送 repair 在本地仍保持 fail-closed。但 `23985777845` 在 `local-foundation` 提前失败，因此这些已推送 repair 仍未获得 same-head non-local closure，不构成 `08.05` 完成依据。后续若再触发新的 pushed-head rerun，必须继续把最新 run id / head sha / `EVID-*` 结果与 blocker 叙述同步回写，而不是保留 `23981099390` 的旧 latest-run 描述。
  `2026-04-04` latest reviewed pushed-head rerun 现也必须同步前推到 `23985777845`（head `36f437764c7638c27303c4d0e243df5bad973101`），因为该 head 的最新 truth 已不再是 `23984768921` 的 pre-release artifact，而是更早的 same-head CI regression：`local-foundation` 在 `Runtime harness parser tests` 失败，`nonlocal` 被整体跳过，`evidence-l1` 只能在缺失全部 non-local attestation 输入的前提下 fail-closed 生成 `phase08-evidence-l1-20260404T191803Z-23985777845-1`。下载并复核该 artifact 后可确认，这轮 same-head evidence 已回退为 attestation-missing baseline：`EVID-GOV-001` 为 `pass`，`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 全部为 `fail`；其中前十项的失败理由都重新回退为所需 non-local environment attestation 缺失，而 `EVID-COST-001` 除了缺失 `pre-release` attestation 外，仍继续额外缺 `prod_cost_snapshot`。因此，当前未推送 `testing-harness.test.mjs` repair 的真实作用只是把 same-head pipeline 恢复到能再次进入 non-local/evidence handoff 的状态；在新的 pushed-head rerun 重新产出 `ci-integration` / `staging` / `pre-release` attestation 之前，`08.05` 仍不能基于 older run truth 继续写成“latest pushed head 仍停留在 `23984768921` 的失败形状”。
  `2026-04-04` latest reviewed pushed-head run 现已前推到 `23986289866`（head `b6b3789eebf51f853cc5b96f295890e644cef553`），而这轮 same-head evidence 真相已进一步收敛：`evidence-l1` 中，`EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002` 为 `pass`；`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 为 `fail`。但与 `23985777845` 不同，这轮 fail shape 已不再是“全部 non-local attestation 缺失”：`evidence-l1` 真实下载并消费了 same-head `ci-integration` 与 `staging` attestation，只是仍缺 `pre-release` attestation 与 `prod_cost_snapshot`。
  同一 run 的 raw `pre-release` artifact 也把该 run 的 remaining blocker 精确改写成了 cost-only shared gate，而不是 `OPS + COST` 并列：`TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 在 pre-release raw suite 中都已 `pass`，`rollout_skew_probe.json` 也已真实存在；但 `TEST-COST-001` 继续按 `OQ-0006` 以 `500/internal` fail-closed，导致 `pre_release_cost_observation` sidecar 缺失，`pre-release` attestation 被整体跳过。因此，这轮 run 的 blocker 已收敛为两类且都与 cost 相关：一是 `OQ-0006` 下的 official billing-grade pre-release cost proof 仍未存在，继续挡住 shared `pre_release_run_report` attestation；二是 `OQ-0002` 下真实 `prod_cost_snapshot` 仍缺失。这个结论同样只描述 `23986289866` 的 run truth，不得覆盖 `2026-04-06` 之后新增的 production automation prerequisite reopen。
  `2026-04-05` latest reviewed pushed-head run 现已再次前推到 `24001049145`（created `2026-04-05T11:59:10Z`，updated `2026-04-05T12:08:16Z`，head `ec1b647e55b7fbb571145cc4a3c5acd43beb99b6`），而这轮 same-head evidence 真相继续证明当时该 head 的 release-evidence blocker 已稳定为 cost-only：`ci-integration` 与 `staging` 均真实成功上传 attestation，`pre-release` raw artifact 也明确记录 `TEST-DER-001`,`TEST-MEDIA-001`,`TEST-OPS-001`,`TEST-SEC-001` 全部 `pass`，`rollout_skew_probe.json` 真实存在；但 `TEST-COST-001` 继续按 `OQ-0006` fail-closed，`pre_release_cost_observation` 仍缺失，pre-release attestation 被整体跳过。对应 `phase08-evidence-l1-20260405T115910Z-24001049145-1` artifact 也据此真实给出：`EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002` 为 `pass`；`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 为 `fail`。这说明 shared pre-release attestation blocker 在该 run 中确实只由 cost 驱动，而不是 DER/OPS dedicated coverage 又回退失效。
  同期 same-head `prod-install` / `prod-cost` remote truth 也把 `OQ-0002` 下的 production blocker 改写成了与 earlier TODO 不同的现实：run `24000789563` 已真实建立 fixed-name prod topology，但 standalone `prod-cost-monthly` run `24000831481` 与 embedded `prod-cost` job in `24001049145` 都在 `GET /billing/usage/paygo?from=2026-03-01&to=2026-03-31` 上收到 `404 page not found`，raw bundle upload 仍被保留，而 `ProdCostSnapshotAttestation` 继续未生成。与此同时，`2026-04-05` 重新核对官方 Cloudflare billing docs 后还能再确认两条 earlier workflow 没有忠实表达的事实：usage-based billing 跟账户 billing period 绑定，不保证等于自然月，因此 `2026-03-01..2026-03-31` 本身只是旧实现的 calendar-month guess，而不是已经被官方 cycle 证明 truthful 的 production snapshot window；而且就算 API access 后续恢复，production snapshot 也仍必须证明 `billing_period.start` 严格晚于当前 prod install baseline 的 `installed_at`，不能把 pre-install spend 混进 fixed topology 账期。本轮 worktree 因而会把这条 production-side contract 一并收紧为“先用官方 billing profile 的 `next_bill_date` 解析 latest closed billing period，再下载并消费当前 prod install baseline，最后才查询 usage API 并生成 self-describing snapshot payload”；但这仍不关闭 blocker，因为 target account 的 Billing Usage API 仍未被 same-head workflow 证明可用，而且当前也仍未到达 fixed prod topology 的第一个 truthful post-install closed billing period。
  `2026-04-05` latest reviewed pushed-head run with substantive same-head evidence artifacts 现已前推到 `24003512030`（head `700b8600264b78eacc07733a7fd09248d9c68e8a`）；同一 head 上更晚的 rerun `24003585072` 在任何 job / artifact 产出前即被取消，不构成新的 evidence truth。这轮 same-head evidence 真相继续维持同一 historical cost-only blocker surface：`phase08-evidence-l1-20260405T142859Z-24003512030-1` artifact 真实给出 `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002` 为 `pass`；`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 为 `fail`。其中前四项已不再是 dedicated coverage、Access topology、rollout-skew proof 或 source-id drift 缺口，而只是继续被 shared pre-release attestation 缺失连带 fail-closed；same-head `EVID-COST-001` 输出里的 `source-ids.json` 现已真实包含 `CF-WKR-029` / `CF-WKR-030`，因此 source-id drift 也不再是该历史 run 的 active blocker。
  同期 standalone `prod-cost-monthly` runs `24003512022`,`24005242689`,`24005804747` 也把 `OQ-0002` 下的 production blocker 进一步前移成了更精确的 then-current `master` truth：revised contract 已真实执行到 `Resolve closed production billing window` 与 prod baseline artifact 下载路径；其中 `24005242689` 证明即使 target account 已拿到新增 billing-view scope，`/billing/profile` 的成功响应仍可能不带 `next_bill_date`，`24005804747` 则进一步证明当时的 `master` head 已能在 same-head remote truth 下退回到唯一的 official subscriptions `current_period_end`，把 `billing-window.json` 解析成 `from_date = 2026-03-01`、`to_date = 2026-03-29`，并在 raw artifact + immutable R2 bundle 保留后，于 `Capture production cost snapshot` 步骤按 fail-closed 语义明确报出 `production cost snapshot requires a closed billing window that starts after prod install date 2026-04-05`。因此 production-side blocker 现阶段已经可以诚实改写成“historical remote billing-cycle closure 已打通，但 current account 仍未到 fixed prod topology 的第一个 truthful post-install closed billing period”；不再需要把它表述成“prod monthly snapshot 仍缺 same-head remote closure”。
  `2026-04-06` merged-master remote truth 还必须把 earlier `08.05A reopen` 叙述回退到更准确的状态：head `2a948e8175efa3dbd089abdb561f2b98b5283248` 的 same-head `Operational Prod Refresh` run `24048353567` 已真实成功，说明 legacy prod baseline normalization defect 不再是 active blocker；而同一 head 的 `Nonlocal Phase 08` run `24048353576` 又真实证明 `L1` 侧 remaining blocker 仍然完全由 cost 驱动，而不是 production automation prerequisite 重新卡住：`ci-integration` 与 `staging` 通过，`pre-release` 继续因为 `TEST-COST-001` 未能产出 `pre_release_cost_observation` 而跳过 shared attestation，`evidence-l1` 随后也继续因为这份 shared pre-release attestation 缺失而 fail-closed，`prod-cost` 则继续缺 truthful monthly snapshot。因此，当前 authoritative `L1` release-gate blocker set 已重新收敛为 `OQ-0006` + `OQ-0002` 两条 cost path；shared pre-release attestation 缺失连带导致 `EVID-MEDIA-001` / `EVID-DER-001` / `EVID-SEC-001` / `EVID-OPS-001` 继续 fail-closed。`TEST-OPS-003` / `EVID-OPS-003` 仍是 production automation support prerequisite，但当前不应再把它与 `L1 Local-Core` mandatory blocker 混写；真正仍不能诚实声称完成的是 `08.05` / Phase 08 overall，而不是“prod baseline parser 仍卡住 current master”。
  但这条 `merged-master` 的 cost-only evidence truth 同样不能直接外推到当前分支 `phase08-nonlocal-closure`。对 pushed head `0df89bc91a70a412ed36eec161e4f9597eb4580a` 的 latest same-head run `24050404771` 复核后可确认，branch 上的 `08.05` 已重新回退为 attestation-missing multi-blocker，而不是 shared pre-release cost-only：`ci-integration` / `staging` / `pre-release` 三个 non-local job 同时失败，`evidence-l1` 因缺少同轮有效 attestation 再次只剩 `EVID-GOV-001` 为 `pass`。其中 `pre-release` 继续忠实暴露 `OQ-0006` blocker，但 `ci-integration` 与 `staging` 的 same-head raw artifact 又额外证明 current branch 还存在 `TEST-CS-001`,`TEST-CS-002`,`TEST-DER-001` 级别的代码回归，所以当前 branch 不能诚实宣称“只剩 `OQ-0006` + `OQ-0002`”。
  `2026-04-06` pushed head `63e594a68f0a0a23c21b62abc298fc2e5ec6fe78` 的 run `24051819997` 仍必须保留为 branch 上 `TEST-CS-001` / `EVID-CS-001` contract 被证伪的审计真相：该 run 中，`ci-integration` / `staging` / `pre-release` 都只上传了 raw artifact，没有任何 attestation artifact，`evidence-l1` 也因此只让 `EVID-GOV-001` 为 `pass`。但这条 historical truth 的意义是证明 branch 当时还不能写成 cost-only，而不是证明后续 repair 没有生效；`24051819997` 同时也已表明 `TEST-CS-002` 与 `TEST-DER-001` 的 earlier raw regressions 已被移除，pre-release 继续只是在 `OQ-0006` 下 truthful fail-closed。
  latest reviewed pushed-head evidence truth 现已前推到 head `1188d2563e2775c2156efdab6a4061e6ade70fd6` 的 run `24054413342`。这轮 same-head evidence 真实显示：`EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002` 为 `pass`；`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 为 `fail`。其中 `EVID-CS-001` 已由 exact-head `ci-integration` + `staging` attestation 加上 required local runtime-control coverage 继续保持诚实 `pass`，说明本轮 evidence honesty sync 没有重新打开 CS parser/harness blocker；而后五项失败也继续不是 dedicated suite / Access / rollout-skew regression 回退，而只是被 shared `pre-release` attestation 缺失连带 fail-closed。对应 `pre-release` raw artifact 明确记录 `TEST-COST-001` 以 `OQ-0006` blocker payload fail-closed，`pre_release_cost_observation = null`，`pre-release` attestation 被整体跳过；`evidence-l1` job log 也同步写出 `prod-cost attestation missing; EVID-COST-001 remains fail-closed until OQ-0002 is resolved`。
  同一 exact-head run `24054413342` 的 embedded `prod-cost` job 还把当前 branch 的 production-side blocker 从 historical merged-master truth 推进成了 branch-owned same-head truth：`Resolve closed production billing window` 已真实通过 subscriptions fallback 写出 `billing-window.json = { resolution_method: cloudflare-account-subscriptions-current-period-end, next_bill_date: 2026-04-29T00:00:00Z, from_date: 2026-03-01, to_date: 2026-03-29 }`，随后 `Capture production cost snapshot` 在同一 job 中按 fail-closed 语义明确报出 `production cost snapshot requires a closed billing window that starts after prod install date 2026-04-05`。因此，当前 branch 的 `08.05` 已可以诚实收敛为 exact-head cost-only blocker set：`OQ-0006` 继续挡住 shared pre-release attestation，`OQ-0002` 继续挡住 truthful `ProdCostSnapshotAttestation`；除此之外没有新的 active `L1` blocker 被这轮 rerun 证实。即便如此，`08.05` 仍未完成，`L1 Local-Core` 也仍不能诚实宣称完成。
  `2026-04-09` latest reviewed pushed-head evidence truth 现已前推到 head `90eb630207a61dd95a14c2a3e08e4b10b1f4b639` 的 run `24169756988`。这轮 same-head evidence 真实显示：`EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-E2E-001` 为 `pass`；`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` 为 `fail`。其中新增变化不是 attestation topology 放松，而是 current head 已真实拿到 `EVID-E2E-001` pass，证明 pinned Element Web + Playwright browser gate 已在 exact-head staging attestation 上闭环；`EVID-CS-004` 也已在同轮 `ci-integration` / `staging` attestation 上继续保持 `pass`。后五项失败仍都不是 dedicated suite 回退：`pre-release.json` 明确记录 `rollout_skew_probe` 存在且 `TEST-OPS-001` assertions 为 `true`，但同轮 `pre_release_cost_observation = null`，因此 shared pre-release attestation 继续缺失；`phase08-prod-cost-raw-20260409T024929Z-24169756988-1/artifacts/billing-window.json` 也继续写出 `{ resolution_method: cloudflare-account-subscriptions-current-period-end, next_bill_date: 2026-04-29T00:00:00Z, from_date: 2026-03-01, to_date: 2026-03-29 }`，而 prod install baseline 仍是 `installed_at = 2026-04-05T11:43:28.305Z`，所以 `OQ-0002` 侧 truthful post-install closed billing period 仍未出现。换言之，`08.05` 当前 exact-head evidence 也已继续收敛为 `OQ-0006` + `OQ-0002` 两条 cost path；`EVID-E2E-001` 不再是 active blocker。

### 08.05B 建立 GitHub Actions supplementary artifact hygiene

- [x] 为高体积、非权威的 GitHub Actions supplementary artifacts 增加独立的定期清理 workflow，防止 Actions storage quota 被历史 `phase08-*` / standalone `prod-cost-*` bundles 长期占满。
  Spec refs: `42`, `44`
  产出:
  独立的 scheduled + manual GitHub artifact cleanup workflow，按名称前缀与时间窗口删除 aged supplementary GitHub artifacts，同时保留 R2 immutable provenance 与 prod record 类 artifacts。
  完成标准:
  仓库可以通过 GitHub Actions 内建 token 回收旧的 `phase08-*` / `prod-cost-*` supplementary GitHub artifacts，不影响 `r2://` provenance truth，也不把仍可能被 prod automation 直接消费的 record artifact 纳入默认删除范围。
  当前状态:
  `2026-04-09` 已新增 `.github/workflows/github-artifact-hygiene.yml`。该 workflow 提供 `workflow_dispatch` 与 daily `schedule`，默认清理前缀为 `phase08-`,`prod-cost-raw-`,`prod-cost-attestation-` 的 aged GitHub artifacts，并支持 `retention_days`,`max_deletions`,`dry_run` 覆盖。实现刻意遵守 `42/44` 的现有 contract：GitHub artifacts 只作为 supplementary audit chain，默认清理范围不触碰 R2 immutable locator，也不默认删除 `prod-install-record` / `prod-promotion-record` / `prod-release-candidate` 等 record artifacts，避免把当前 production automation 仍通过 GitHub artifact 下载的 ingress 直接打断。

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
