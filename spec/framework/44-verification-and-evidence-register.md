# Verification and Evidence Register

状态：Draft-Normative
角色：验证证据分册
负责主文档章节：7
扩展范围：全部 requirement / contract / constraint 的验证闭环

## 1. 文档职责

* 统一登记测试证据与发布门禁证据。
* 把“通过了什么、如何证明、证据存在哪里”从测试策略中分离出来。
* 为“文档即真相”补齐可验证性闭环。

## 2. Artifact Convention

### 2.1 证据位置约定

证据工件路径必须遵循：

* `evidence/<scope>/<EVID-ID>/<run_ts>/summary.md`
* `evidence/<scope>/<EVID-ID>/<run_ts>/artifacts/...`

其中 `<scope>` 只允许 `L1`、`L2`、`L3` 或 `common`。

若工件体积过大，可放在外部对象存储，但必须在 `summary.md` 中保留不可变引用。

### 2.2 结果状态

* `pass`
* `fail`
* `waived`
* `superseded`

失败证据不得删除，只能被后续证据 supersede。

### 2.3 `Source IDs` 语法规则

* `Source IDs` 默认使用逗号分隔的 canonical ID 列表。
* 区间写法例如 `<REQ-ID-START>-<REQ-ID-END>` 一律禁止；进入仓库前必须展开为显式枚举。
* 前缀通配仅允许使用末尾 `*` 形式，例如 `REQ-SEC-*`、`CF-*`；其规范含义是“匹配当前仓库中该前缀下的全部已登记 canonical IDs”。
* 任何涉及 `REQ-*` 的通配、交集或展开，都必须以同次 `EVID-GOV-001` 产出的 `requirement-register.csv/json` 为唯一输入，而不是直接扫描仓库文本。
* 任何包含通配的证据项，都必须在对应 `summary.md` 或并列机器工件中输出“本次运行实际展开后的完整 ID 清单”，作为审计快照。
* CI traceability 工具必须先展开通配，再做闭环校验；不得把未展开表达式直接当作已验证结果。
* 若某 `EVID-ID` 的 `Source IDs` 横跨多个 `Release Profile`，则实际门禁判定必须先与目标 profile 做交集；`summary.md` 必须同时输出“声明的 Source IDs 全集”和“本次按目标 profile 实际适用的 Source IDs 子集”。

### 2.4 Non-local Attestation Rules

* 任何依赖 `ci-integration`、`staging`、`pre-release` 或 `prod` 外部工件的 `EVID-ID`，都必须导入 [26-wire-schema-catalog.md](/root/Matrix/spec/framework/26-wire-schema-catalog.md) 定义的 attestation bundle，而不是裸 run report / prod snapshot JSON。
* `ci-integration`、`staging`、`pre-release` 环境必须使用 `EnvironmentRunAttestation`；production monthly cost snapshot 必须使用 `ProdCostSnapshotAttestation`。
* attestation 至少必须保留：canonical payload、origin run identity、deployment identity、artifact store immutable reference、artifact digest、review record reference。
* 对 Phase 08 non-local harness，acceptance provenance chain 固定为：GitHub Actions run URL / run ID / run attempt，外加 Cloudflare R2 immutable object locator（`r2://bucket/key` 或等价可审计外部 locator）与其 SHA-256 digest；GitHub artifact URL / digest 可以作为补充 provenance 保留，但不能替代 R2 object reference。
* consumer 必须 fail-closed，除非 attestation provenance 同时满足：`origin_system == github-actions`、`origin_repository` 为非空 GitHub `owner/repo` slug、`origin_run_uri` 为且仅为该 repository 的 GitHub Actions run URL、`artifact_store_uri` 为 `r2://bucket/key` 形式的 immutable object locator、`artifact_store_key` 与该 locator 一致、`artifact_store_key` 还能一致编码 `origin_run_id` / `origin_run_attempt` / `source_environment` / `run_timestamp`、`deployment_identity.environment_id` 与 attestation `source_environment` 一致。
* 所有 provenance / payload 中以 `_uri` 结尾的 locator 字段，都必须是可解析的绝对外部 URI / locator，且需具 authority，或使用格式完整的 `urn:<nid>:<nss>`；裸 `urn:`、占位字符串、`about:`、`blob:`、`file:`、`data:`、`javascript:` 等本地或不可审计引用必须 fail-closed。
* `summary.md` 或并列机器工件必须保留 attestation provenance snapshot，足以让审计者回链到外部 workflow / deployment / artifact store / review record。
* 若 non-local harness 需要 deploy 后 readiness gate，则 raw bundle / `summary.md` / 并列机器工件还必须保留 readiness snapshot，至少包含探测目标、尝试次数、最终通过时间或最后失败原因；不得只保留最终 suite 结果而抹去 readiness 等待事实。
* 用于证明某个 `TEST-ID` 已被 non-local gate 覆盖的 canonical implementation files，必须是对应环境目录中专门维护的 dedicated `.test.mjs` suite files；它们必须留在对应环境目录内，不得回指 `tests/shared/*` 支撑模块，也不得使用 `bootstrap.test.mjs`、`l1-mandatory.test.mjs` 这类 generic bootstrap/smoke entrypoint 充作 coverage proof。为保持 fail-closed，它们的 basename 还必须以对应 `TEST-ID` 的小写形式起始，并只允许在该前缀后追加 `.` / `-` 分隔的限定词再接 `.test.mjs`；consumer 还必须验证这些 canonical files 在仓库内真实存在，缺失 file path 必须直接判为 `mapping_error`；同时，consumer 还必须验证这些 canonical files 的 repo-owned transitive dependency closure 仍留在同一环境目录内，否则该 `TEST-ID` mapping 必须直接判为 `mapping_error`。
* 任何来自 `evidence/common/_test-runs/` 的本地产物、或仍扩展 `tests/local/*` 的薄 harness 结果，都不得被提升为 non-local release evidence。
* `TEST-OPS-001` 所依赖的 pre-release attested report 还必须包含 `rollout_skew_probe`，至少记录 baseline/candidate gateway version IDs、对应 official version tags、dual-version deployment ID 与两类 pairing assertion；对每条 observation，还必须保留官方 `observed_gateway_version_id`（若 runtime 提供）和 `observed_gateway_version_tag`（若 runtime 提供）。当 runtime 未提供官方 version ID 时，consumer 必须允许 `observed_gateway_version_id = null`，并改用 official version tag 完成 override 观测；缺失两者、或把 repo-local fallback 冒充 official version ID 时，`EVID-OPS-001` 必须 fail-closed。
* `TEST-COST-001` 的 pre-release half 还必须在 attested report 中包含 `pre_release_cost_observation`，并保留 official Cloudflare HTTPS query source locators（`cloudflare.com` 或其子域）；缺失或使用非官方 locator 时 `EVID-COST-001` 必须 fail-closed，即便 production snapshot 另行提供也不例外。
* `EVID-OPS-003` 在 remote workflow 最终失败时，仍要求至少保留 raw blocker artifacts；`release-candidate`、`prod-install`、`promote-prod`、`rollback-prod` 都必须先留下 workflow raw state / blocker artifact，`prod-cost-monthly` 还必须先把 raw cost bundle 上传到 immutable R2，再允许 provenance / attestation 阶段 fail-closed。

## 3. Evidence Catalog

| EVID-ID | Source IDs | Evidence Type | Generation Method | Environment | Frequency | Pass Criteria | Artifact Location | Retention | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `EVID-GOV-001` | `REQ-*`,`MX-*`,`CF-*`,`IF-*`,`DATA-*`,`FLOW-*`,`STATE-*`,`TEST-*`,`EVID-*`,`DEC-*`,`OQ-*` | governance | CI traceability report | CI | per commit | ID 链接完整、无断链、无未登记引用、产出完整 requirement register、traceability matrix、wildcard route expansion 审计快照与 explicit compatibility alias route-set lock snapshot、source observation register 已校验、无 compatibility page 或 `92-appendices` 中 `2.1-2.8` placeholder/informative sections 被当作权威正文引用、无把仅靠 `Deferred` 降级而未经 `DEC` 或 contracts 收敛的 `OQ` 误标为 `closed` | `evidence/common/EVID-GOV-001/` | release lifetime | architecture |
| `EVID-CS-001` | `MX-CS-001`,`MX-CS-002`,`MX-CS-003`,`MX-CS-005`,`MX-CS-006`,`MX-CS-019`,`MX-CS-024`,`MX-CS-026` | integration/protocol | client-core CI + staging attestation bundle | CI + staging | per release candidate | discovery/capabilities/session/profile/password-change/deactivate 核心用例与 profile propagation 基线全通过，且 `/.well-known/matrix/client`、`/_matrix/client/versions`、`GET /login`、`GET /register`、`GET /register/available`、`GET /capabilities` 对真实 route truth、disabled login-token、3PID surfaces 与 `m.profile_fields` 的宣告一致；对 `r0` / `v1` / `v3` compatibility aliases，attestation 还必须逐别名证明 `GET /login` / `GET /register` / `GET /register/available`、`POST /register {}` 初始 `401` UIA challenge、成功 registration、成功 password login、unsupported login type / wrong-password 错误模型、以及 session issuance / `device_id` 副作用 parity，不得因 alias 不同而漂移；同一 bundle 还必须保留 alias discovery surfaces 的 `Cache-Control` 真值证明，其中 `GET /login` 为 `public, max-age=60`，`GET /register` / `GET /register/available` 为 `no-store`，并证明 anonymous public-entry limiter 生效时这些 alias discovery GET surfaces 都会返回 live `429 M_LIMIT_EXCEEDED`；browser-style `Origin`/`OPTIONS` CORS-preflight 行为也必须通过。此外 password-change 至少覆盖带 token 与 tokenless password-UIA 两个分支，profile 至少覆盖 full-read、`keyName` GET/PUT/DELETE、`m.tz`/custom-field 与 propagation 行为 | `evidence/L1/EVID-CS-001/` | release lifetime | client protocol |
| `EVID-CS-002` | `MX-CS-004`,`MX-CS-006`,`MX-CS-007`,`MX-CS-010`,`MX-CS-015` | protocol | `/sync` conformance attested staging report | staging | per release candidate | filter lifecycle、`include_leave`、lazy-load members、initial/incremental/limited/`full_state`/`use_state_after`、push rules 与 notification counts 全通过 | `evidence/L1/EVID-CS-002/` | release lifetime | client protocol |
| `EVID-CS-003` | `MX-CS-013`,`MX-CS-014` | protocol | devices/E2EE transport attested staging report | staging | per release candidate | key claim at-most-once、device CRUD/delete UIA、cross-signing upload/signature handling、`/sync` 的 `device_lists` / `device_one_time_keys_count` / `device_unused_fallback_key_types` 真值，以及 backup metadata/object handling 通过 | `evidence/L1/EVID-CS-003/` | release lifetime | client protocol |
| `EVID-CS-004` | `MX-CS-003`,`MX-CS-005`,`MX-CS-012`,`MX-CS-016`,`MX-CS-018`,`MX-CS-020`,`MX-CS-021`,`MX-CS-022`,`MX-CS-023`,`MX-CS-025`,`MX-CS-027`,`MX-CS-028`,`MX-CS-029` | protocol/governance | stub-only/unsupported route guard attested CI + staging report | CI + staging | per release candidate | stub-only/unsupported route guards 返回固定 disabled/unsupported wire behavior、无 truth write、无 feature-flag 漂移，且 discoverability 面不会与 stub truth 冲突 | `evidence/L1/EVID-CS-004/` | release lifetime | client protocol + architecture |
| `EVID-ROOM-001` | `MX-CS-008`,`MX-CS-009`,`MX-CS-010` | property/integration | room-core attested CI + staging report | CI + staging | per release candidate | 本地房间行为和 fanout 全通过 | `evidence/L1/EVID-ROOM-001/` | release lifetime | room core |
| `EVID-ROOM-002` | `MX-RV-011`,`MX-RV-012` | protocol/property | room-version attested CI + staging report | CI + staging | per release candidate | `L1` 时 room version `12` 行为通过；`L2-L3` 时 room version `11/12` 差异行为通过 | `evidence/L1/EVID-ROOM-002/` | release lifetime | room core |
| `EVID-FED-001` | `MX-FED-001`,`MX-FED-002`,`MX-FED-003`,`MX-FED-005`,`MX-FED-006`,`MX-FED-007` | federation | federation-core report | staging | per release candidate | 发现、验签、事务、握手、user-device/key exchange，以及 query-surface auth/routing 全部通过，并证明对等价请求时 federation `publicRooms` 的 `GET` / `POST` 变体共用同一 query / visibility truth path | `evidence/L2/EVID-FED-001/` | release lifetime | federation |
| `EVID-FED-002` | `MX-FED-004` | chaos/recovery | federation recovery report | pre-release | per release candidate | gap repair / backfill 场景通过 | `evidence/L2/EVID-FED-002/` | release lifetime | federation |
| `EVID-FED-003` | `MX-FED-009`,`MX-FED-010` | protocol/governance | federation unsupported-route guard report | CI + staging | per release candidate | unsupported federation routes 返回固定 wire behavior、无 identity/token/membership truth write、无 auth 漂移 | `evidence/L2/EVID-FED-003/` | release lifetime | federation + architecture |
| `EVID-MEDIA-001` | `MX-CS-011`,`MX-FED-008` | integration/load | media pipeline attested staging + pre-release report | staging + pre-release | per release candidate | `L1` 至少覆盖本地 upload/download/thumbnail、authenticated current media surface，以及 deprecated `/_matrix/media/*/download` / `thumbnail` 的 legacy unauthenticated + freeze 行为，并证明 animated thumbnail 变体不会污染 non-animated cache key；`L2-L3` 另外覆盖 federation media serve 与 remote cache 行为，包括 deprecated unauthenticated routes 在 freeze 之后对 cache miss 不会触发新的远端抓取；所有适用子集都必须通过 | `evidence/L1/EVID-MEDIA-001/` | release lifetime | media |
| `EVID-DER-001` | `MX-CS-017`,`MX-FED-006` | integration/rebuild | derived-data attested staging + pre-release report | staging + pre-release | per release candidate | `L1` 至少覆盖 client search/user_directory/publicRooms/hierarchy 与 rebuild 一致性，并证明对等价请求时匿名 `GET /publicRooms` 与鉴权态 `POST /publicRooms` 共用同一 query semantics，同时证明未带 access token 的 `POST /publicRooms` 被 deterministic 拒绝；`L2-L3` 另外覆盖 federation query-surface 的 derived/truth fail-closed 行为；所有适用子集都必须通过 | `evidence/L1/EVID-DER-001/` | release lifetime | derived services |
| `EVID-AS-001` | `MX-AS-001`,`MX-AS-002`,`MX-AS-003`,`MX-CS-017` | integration | appservice and derived-data report | staging | per release candidate when enabled | namespace、txn delivery、directory side-effects 通过 | `evidence/L3/EVID-AS-001/` | release lifetime | integrations |
| `EVID-SEC-001` | `REQ-SEC-*`,`MX-CS-002`,`MX-CS-003`,`MX-CS-005`,`MX-CS-016`,`MX-CS-024`,`MX-CS-025`,`MX-CS-026`,`MX-CS-028`,`MX-FED-002` | security | security attested staging + pre-release bundle | staging + pre-release | per release candidate | `L1-L2` 至少覆盖 token revocation、UIA route binding、secret handling 与 always-on surfaces 的 baseline abuse guards；`L2-L3` 另外覆盖联邦鉴权失败路径；若启用 SSO / 3PID / requestToken / pushers / TURN credentials，则对应条件能力也必须在同一 bundle 中通过 | `evidence/common/EVID-SEC-001/` | release lifetime + 1 audit cycle | security |
| `EVID-OPS-001` | `REQ-OPS-010`,`REQ-OPS-011`,`REQ-OPS-012` | deploy | rollout compatibility attested pre-release report | pre-release | per release candidate | pre-release report 包含有效 `rollout_skew_probe`，且 `new Worker -> old DO` / `old Worker -> new DO` 两类 assertion 都为 `true` | `evidence/common/EVID-OPS-001/` | release lifetime | platform |
| `EVID-OPS-002` | `REQ-OPS-013`,`DATA-OPS-*` | recovery/drill | replay/rebuild/restore drill report | periodic drill | quarterly + pre-release for major releases | restore/rebuild 成功且 checkpoint/manifest 完整，并证明 “truth 已提交但 `DATA-OPS-010` 缺行” 场景会由同一幂等请求或内部 pending-marker 重试修复，且不会产生重复 shard truth | `evidence/L3/EVID-OPS-002/` | 2 years | platform + SRE |
| `EVID-OPS-003` | `REQ-OPS-003`,`REQ-OPS-010`,`REQ-OPS-011`,`REQ-OPS-012`,`DATA-OPS-014`,`DATA-OPS-015`,`DATA-OPS-016`,`DATA-OPS-017`,`DEC-0005`,`DEC-0006` | production automation | local contract report + same-head prod workflow artifacts | CI + prod | per prod automation change and per same-head proof | `TEST-OPS-003` 对应 local contract tests 全通过，且 same-head workflow 真实证明 reviewed candidate / prod install / prod promote / operational prod refresh / prod rollback / prod-cost raw blocker retention contract 与当前 head 一致；若 remote proof 尚缺，则 evidence 必须把 blocker 诚实写成 fail，而不是口头跳过 | `evidence/common/EVID-OPS-003/` | release lifetime | platform |
| `EVID-PERF-001` | `REQ-OPS-001`,`REQ-OPS-002`,`REQ-OPS-003`,`REQ-OPS-004`,`REQ-OPS-005` | load | performance benchmark report | pre-release | per release candidate | `/sync`、hot room、derived lag budgets达标 | `evidence/common/EVID-PERF-001/` | release lifetime | performance |
| `EVID-COST-001` | `REQ-OPS-003`,`CF-WKR-015`,`CF-WKR-016`,`CF-WKR-017`,`CF-WKR-018`,`CF-WKR-019`,`CF-WKR-029`,`CF-WKR-030`,`CF-DO-011`,`CF-DO-012`,`CF-DO-013`,`CF-D1-006`,`CF-KV-003`,`CF-R2-005`,`CF-QUE-001` | cost | attested monthly dashboard snapshot + model comparison | prod + pre-release | monthly and pre-release | 同一 evidence bundle 必须同时包含有效 `pre_release_cost_observation` 与 `ProdCostSnapshotAttestation`，且主要计费面与预算模型一致、无异常漂移；其中 production snapshot 的 `source_dashboard_uri` 与 `billing_cycle_anchor_source_uri` 都必须是官方 Cloudflare HTTPS locator，`billing_cycle_anchor_artifact` 还必须把 attestation provenance 指向的 raw bundle 中哪份 retained artifact / field selector 才是 anchor 证据写清楚，`billing_window_resolution_method` 只允许 `cloudflare-account-billing-profile-next-bill-date` 或 `cloudflare-account-subscriptions-current-period-end`，`billing_period` 必须对应 official Cloudflare latest closed billing period，而不是默认 previous calendar month，并且 `billing_period.start` 必须严格晚于 `topology_baseline_install.installed_at` 对应 UTC 日期 | `evidence/common/EVID-COST-001/` | 13 months | platform finance |

## 4. Release Gate Evidence Sets

| Profile ID | Canonical Name | Mandatory EVID IDs |
| --- | --- | --- |
| `L1` | `Local-Core` | `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-CS-004`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` |
| `L2` | `Federation-Core` | `L1` + `EVID-FED-001`,`EVID-FED-002`,`EVID-FED-003` |
| `L3` | `Enterprise-Hardening` | `L2` + `EVID-AS-001` when enabled, `EVID-OPS-002`,`EVID-PERF-001` |

## 5. Evidence Closure Rules

* `Required-Core` requirement 没有 `EVID-ID` 则视为未闭环。
* 证据必须可回链到 `REQ`、`MX`、`IF` 或 `DATA`，不能孤立存在。
* 失败证据必须保留并标注处置结果。
* waived 证据必须指向 `DEC-ID`，说明豁免范围和失效时间。

## 6. 审计规则

* 发布评审必须基于证据寄存器，而不是口头结论。
* 任何 `pass` 证据都必须有明确生成环境、时间戳、代码版本和数据版本上下文。
* 任何人工步骤都必须记录执行者与审查者。
* 任何 non-local `pass` 证据都必须额外保留 attestation provenance：origin run identity、deployment identity、artifact store immutable reference、artifact digest 与 review record reference。

## 7. 完成标准

* 验证和证据已经分离建模；
* 任何规范声明都能知道要看什么证据；
* 发布门禁可被审计；
* 可直接支持企业级发布评审。
