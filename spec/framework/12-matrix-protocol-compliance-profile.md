# Matrix Protocol Compliance Profile

状态：Draft-Normative
角色：Matrix 覆盖矩阵分册
负责主文档章节：1，4，7
扩展范围：全部 Matrix 协议面

## 1. 文档职责

* 为 Matrix 协议实现建立覆盖矩阵。
* 规定每个协议面、接口组、事件类型、房间版本规则在本项目中的支持级别。
* 规定每个协议 requirement 的唯一 owning spec、runtime component、test 和 evidence。
* 为“完全符合规范”的声明建立可审计基础。

明确不包含：

* 不代替各责任分册展开正文；
* 不直接定义 Cloudflare 平台限制；
* 不代替测试分册设计测试策略。

## 2. 当前实现基线与发布 Profile

### 2.1 Matrix 基线

* 当前实现基线：Matrix `v1.17`。
* `latest` 的最近一次观察结果、观察日期与 delta 结论，统一以 [15-source-observation-register.md](/root/Matrix/spec/framework/15-source-observation-register.md) 为准。
* 协议支持声明一律以 `v1.17` versioned spec 为准，而不是 unversioned latest 页面。

### 2.2 发布 Profile

| Profile ID | Canonical Name | Meaning |
| --- | --- | --- |
| `L0` | `Doc-System` | 仅文档系统成立，不代表可运行实现 |
| `L1` | `Local-Core` | 本地 homeserver 核心闭环，不开启联邦 |
| `L2` | `Federation-Core` | 开启联邦后的核心闭环 |
| `L3` | `Enterprise-Hardening` | 在 `L2` 基础上补齐企业级安全、恢复、观测和运维门禁 |

### 2.3 Profile 标记规则

* 本分册、测试分册和证据分册只使用 `L0`、`L1`、`L2`、`L3` 作为规范 profile ID。
* `L1-L3` 表示对 `L1`、`L2`、`L3` 全部成立。
* `L2-L3` 表示只对 `L2`、`L3` 成立。
* `L3 when enabled` 等 guarded form 只表示“进入 `L3` 且对应功能开关启用”时成立。
* `Release Profile` 列表达的是“该 `MX-ID` 在哪些 profile 下必须有外部可观察真值”，这包括功能关闭时的 deterministic stub truth；是否允许 full feature 打开，仍由 `Support Level` 与 `Notes` 共同裁决。
* 若某 `MX-ID` 被 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明确收敛为 stub-only product boundary，则 `Required-Conditional`、feature flag、局部 handler 落地或 capability 开关本身都不构成有效启用；只有 dedicated sub-spec 完整落地并由新的或替代的 `DEC-ID` 显式放开后，才允许从 deterministic stub truth 转为 full feature。
* 对当前已被产品边界固定为 deterministic stub truth 的 surface，`Support Level` 必须写成 `Stub-Only`，而不是继续复用 `Required-Conditional` 或 `Deferred` 让读者误以为“只差开关”。

### 2.4 支持级别枚举

* `Required-Core`：该 profile 下必须实现并通过门禁。
* `Required-Conditional`：当对应功能开关启用时必须完整实现。
* `Stub-Only`：该 profile 下必须提供 deterministic stub / disabled wire truth；在新的或替代的 `DEC-ID` 放开前，不允许把局部 handler、feature flag 或 capability 视为 full feature 启用。
* `Deferred`：计划支持，但当前 profile 不允许宣称完成。
* `Unsupported`：当前产品边界明确不支持。
* `Not-Applicable`：对本项目范围不适用。
* `Experimental`：仅实验，不能用于 GA 真相。

## 3. 覆盖矩阵规则

### 3.1 当前粒度

本分册当前以 “协议能力族 / 行为族” 粒度维护 `Draft-Normative` 覆盖矩阵，用于固定支持边界与主责落位。

进入 `Normative` 前，必须补齐到：

* 每个公开端点至少一条 `MX-ID`
* 每个重要事件类型或跨端点语义规则至少一条 `MX-ID`
* 每个目标房间版本特性至少一条 `MX-ID`

### 3.2 表头

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 4. Client-Server Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-CS-001` | Client-Server | `v1.17` | discovery, `/.well-known/matrix/client`, `/_matrix/client/versions` | `Required-Core` | `30` | `gateway-worker` | `IF-PUB-001`,`IF-CS-001` | `DATA-KV-001` | `FLOW-CS-DISCOVERY` | `TEST-CS-001` | `EVID-CS-001` | `L1-L3` | 基线发现与能力声明；`/_matrix/client/versions` 必须枚举当前 profile 真正宣称支持的稳定版本阶梯（当前为 `v1.1`~`v1.17`），不得只返回最新版本，否则当前 browser SDK 的 exact-match homeserver validation 会把“更新”误判成“不支持”。 |
| `MX-CS-002` | Client-Server | `v1.17` | registration availability, registration, login discovery/exchange, refresh, logout, `whoami` | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-005`,`IF-CS-009`,`IF-CS-010`,`IF-CS-011`,`IF-CS-012`,`IF-CS-013`,`IF-CS-014`,`IF-CS-066`,`IF-CS-067` | `DATA-USER-001`,`DATA-USER-002`,`DATA-USER-017`,`DATA-ID-003`,`DATA-ID-004`,`DATA-ID-006` | `FLOW-CS-UIA`,`FLOW-CS-REGISTER`,`FLOW-CS-LOGIN`,`FLOW-CS-REFRESH`,`STATE-USER-SESSION`,`STATE-UIA-SESSION` | `TEST-CS-001`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-SEC-001` | `L1-L3` | `GET /login` 必须只宣告当前真实支持的 flow；默认不宣称 SSO / login-token；`GET /register` 兼容发现面、`GET /register/available` 与 `GET /register/m.login.registration_token/validity` 都必须与本地 registration policy 真值一致；`r0` / `v1` / `v3` login/register compatibility aliases 必须对同一 password / dummy truth 保持一致；`m.login.application_service` 的 legacy client auth 语义当前仍受 [`OQ-0008`](/root/Matrix/spec/open-questions/OQ-0008.md) 约束，未闭合前不得被隐式宣称为已支持。 |
| `MX-CS-003` | Client-Server | `v1.17` | OAuth/OIDC auth metadata, SSO redirect, login-token issuance, and identity-provider login | `Stub-Only` | `30`,`40` | `gateway-worker`,`UserDO` | `IF-CS-059`,`IF-CS-065` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-001`,`TEST-CS-004`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-CS-004`,`EVID-SEC-001` | `L1-L3` | 包括 `GET /_matrix/client/v1/auth_metadata`、`GET /_matrix/client/*/login/sso/redirect*` 与 `POST /_matrix/client/v1/login/get_token`；`L1-L3` 都必须维持 deterministic stub truth；仅在 `L3`、dedicated SSO/OIDC 子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开后，才允许启用完整功能。 |
| `MX-CS-004` | Client-Server | `v1.17` | account data, tags, ignored users, direct rooms | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-015` | `DATA-USER-006`,`DATA-USER-007`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-002` | `EVID-CS-002` | `L1-L3` | 所有变更必须进入用户流。 |
| `MX-CS-005` | Client-Server | `v1.17` | 3PID bind/unbind and identity-service-assisted flows | `Stub-Only` | `30`,`40` | `gateway-worker`,`UserDO` | `IF-CS-060` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-001`,`TEST-CS-004`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-CS-004`,`EVID-SEC-001` | `L1-L3` | 包括 `/_matrix/client/*/account/3pid*` 路由族；本系统不内建 Identity Service；`L1-L3` 都必须维持 deterministic stub truth，默认关闭时 capability 必须显式给出 `m.3pid_changes.enabled = false`；只有 dedicated contracts 完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开后，才允许启用完整功能。 |
| `MX-CS-006` | Client-Server | `v1.17` | capabilities, filter create/get, and filter application to `/sync` | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-002`,`IF-CS-003`,`IF-CS-004`,`IF-CS-020` | `DATA-ID-001`,`DATA-USER-014` | `FLOW-CS-DISCOVERY`,`FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-001`,`TEST-CS-002` | `EVID-CS-001`,`EVID-CS-002` | `L1-L3` | capability 声明与实际写权限、filter 解析行为必须一致。 |
| `MX-CS-007` | Client-Server | `v1.17` | `/sync` initial/incremental/long-poll/`use_state_after` | `Required-Core` | `30` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-020`,`IF-INT-USER-002`,`IF-INT-USER-007`,`IF-INT-ROOM-002` | `DATA-ID-001`,`DATA-USER-009`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL`,`STATE-SYNC-WAITER` | `TEST-CS-002` | `EVID-CS-002` | `L1-L3` | 由 Worker 持有长轮询；`since` token 绑定的是用户/设备/流位置而不是上一次 `filter` 表示法，调用方必须可以在后续增量请求中在 inline JSON 与 stored `filter_id` 之间切换而不被错误判成 token mismatch；`L3` 另外受 `TEST-PERF-001`/`EVID-PERF-001` 约束。 |
| `MX-CS-008` | Client-Server | `v1.17` | room creation, membership, pagination, event retrieval, member listing, relations, threads, timestamp lookup | `Required-Core` | `31` | `gateway-worker`,`RoomDO`,`UserDO` | `IF-CS-030`,`IF-CS-031`,`IF-CS-034` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010`,`DATA-ROOM-011` | `FLOW-CS-ROOM-MEMBERSHIP`,`FLOW-CS-ROOM-QUERY`,`STATE-ROOM-MEMBERSHIP` | `TEST-ROOM-001`,`TEST-ROOM-002` | `EVID-ROOM-001`,`EVID-ROOM-002` | `L1-L3` | 包括 join/invite/leave/knock/forget 的本地语义，以及只读房间查询面。 |
| `MX-CS-009` | Client-Server | `v1.17` | room state send/get, timeline event send, redaction | `Required-Core` | `31` | `gateway-worker`,`RoomDO` | `IF-CS-032`,`IF-CS-033`,`IF-CS-034`,`IF-CS-035` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-011`,`DATA-ROOM-012` | `FLOW-ROOM-EVENT-ADMISSION`,`FLOW-CS-ROOM-QUERY`,`STATE-ROOM-EVENT-ADMISSION` | `TEST-ROOM-001`,`TEST-ROOM-002` | `EVID-ROOM-001`,`EVID-ROOM-002` | `L1-L3` | room version 差异由 strategy 层裁决。 |
| `MX-CS-010` | Client-Server | `v1.17` | typing, receipts, read markers, presence | `Required-Core` | `30`,`31` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-015`,`IF-CS-016`,`IF-CS-019`,`IF-CS-020` | `DATA-ROOM-009`,`DATA-ROOM-010`,`DATA-USER-009`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-002`,`TEST-ROOM-001` | `EVID-CS-002`,`EVID-ROOM-001` | `L1-L3` | ephemeral 失败不得污染 timeline truth。 |
| `MX-CS-011` | Client-Server | `v1.17` | media config, upload, download, thumbnail | `Required-Core` | `33` | `gateway-worker`,`UserDO`,R2 | `IF-CS-050`,`IF-CS-051`,`IF-QUE-002` | `DATA-USER-015`,`DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD`,`FLOW-CS-MEDIA-DOWNLOAD`,`FLOW-CS-REMOTE-MEDIA-FETCH` | `TEST-MEDIA-001` | `EVID-MEDIA-001` | `L1-L3` | `/_matrix/client/v1/media/{config,download,thumbnail}` 是 `v1.17` current authenticated media surface，当前 profile 下这些路由必须要求 access token；`/_matrix/media/*` 前缀同时包含 current upload surfaces 与 deprecated compatibility surfaces，不能整前缀一概而论：其中 `config` compatibility 路由仍要求 access token，而 deprecated `download` / `thumbnail` compatibility 路由必须保留 `v1.17` 的 legacy unauthenticated + freeze 语义，不得改变 query 参数解释。对 browser-readable 的 `GET /_matrix/client/v1/media/config` 与 `GET /_matrix/media/*/config`，`gateway-worker` 还必须返回一致的 CORS allow-origin 语义，并在带 `Authorization` 的 `OPTIONS` preflight 上直接终结为成功响应，避免 Web client 的 authenticated media config fetch 被浏览器层阻断。上传仍受 Cloudflare request body limit 约束。 |
| `MX-CS-012` | Client-Server | `v1.17` | URL preview | `Stub-Only` | `33`,`40` | isolated preview worker | `IF-CS-058` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004` | `EVID-CS-004` | `L1-L3` | 包括 `GET /_matrix/client/v1/media/preview_url` 与已弃用的 `GET /_matrix/media/v3/preview_url`；在 dedicated IF/DATA/FLOW 与 SSRF 子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开前，不允许宣称支持。 |
| `MX-CS-013` | Client-Server | `v1.17` | devices, to-device messaging | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-040`,`IF-CS-041` | `DATA-USER-002`,`DATA-USER-008`,`DATA-USER-010`,`DATA-USER-016` | `FLOW-CS-DEVICE-MANAGEMENT`,`FLOW-CS-SEND-TO-DEVICE`,`STATE-DEVICE-LIFECYCLE` | `TEST-CS-003` | `EVID-CS-003` | `L1-L3` | 每目标设备的投递必须线性化。 |
| `MX-CS-014` | Client-Server | `v1.17` | E2EE transport: keys upload/query/claim/changes, cross-signing, backup | `Required-Core` | `30` | `gateway-worker`,`UserDO`,R2 | `IF-CS-042`,`IF-CS-043`,`IF-CS-044`,`IF-CS-048`,`IF-CS-045`,`IF-CS-046`,`IF-CS-047`,`IF-INT-USER-004` | `DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-011`,`DATA-R2-006`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-003` | `EVID-CS-003` | `L1-L3` | homeserver 只负责传输与存储边界；`/keys/changes` 必须基于 `/sync` token 真值返回 `changed` / `left`，不得另造独立游标，且调用方对共享加密房间用户的观察必须通过其自身 `DATA-USER-010.device_state` fanout 真值收口。 |
| `MX-CS-015` | Client-Server | `v1.17` | push rules, unread counters, and notification counts in `/sync` | `Required-Core` | `30`,`31` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-018`,`IF-CS-020` | `DATA-USER-013`,`DATA-USER-010`,`DATA-USER-006`,`DATA-USER-007`,`DATA-ROOM-007`,`DATA-ROOM-009` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-002` | `EVID-CS-002` | `L1-L3` | 默认规则来自 Matrix `v1.17`；只把用户覆盖持久化；本条只覆盖 `/sync` 内 notification counts，不隐含 `/_matrix/client/*/notifications` 路由。 |
| `MX-CS-016` | Client-Server | `v1.17` | pushers and external push gateway integration | `Stub-Only` | `30`,`40` | `gateway-worker`,`UserDO` | `IF-CS-055` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004`,`TEST-SEC-002` | `EVID-CS-004`,`EVID-SEC-001` | `L1-L3` | 包括 `GET /_matrix/client/*/pushers` 与 `POST /_matrix/client/*/pushers/set`；`L1-L3` 都必须维持 deterministic disabled truth；仅在 dedicated contracts、外部推送网关子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开后，才允许启用完整功能。 |
| `MX-CS-017` | Client-Server | `v1.17` | search, user directory, public rooms, client hierarchy | `Required-Core` | `34` | `gateway-worker`,`jobs-worker`,D1 | `IF-CS-052`,`IF-INT-WKR-001`,`IF-QUE-001` | `DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003` | `FLOW-CS-SEARCH-QUERY`,`FLOW-SEARCH-INDEX` | `TEST-DER-001` | `EVID-DER-001` | `L1-L3` | 仅覆盖 `search`、`user_directory`、`publicRooms` 与 `rooms/{roomId}/hierarchy`；其中对等价请求，匿名 `GET /publicRooms` 与鉴权态 `POST /publicRooms` 必须共用同一 query semantics；alias/directory、`joined_rooms` 与 `room_summary` 由独立条目管理；`L3` 另外受 `TEST-OPS-002`/`EVID-OPS-002` 恢复门禁约束。 |
| `MX-CS-018` | Client-Server | `v1.17` | reporting APIs and abuse-report submission | `Stub-Only` | `40` | `gateway-worker`,`ops-worker` | `IF-CS-057` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004` | `EVID-CS-004` | `L1-L3` | 包括 `POST /_matrix/client/*/rooms/{roomId}/report`、`POST /_matrix/client/*/rooms/{roomId}/report/{eventId}` 与 `POST /_matrix/client/*/users/{userId}/report`；只有在运维处置流程与 abuse workflow 子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开后，才允许 GA。 |
| `MX-CS-019` | Client-Server | `v1.17` | profile APIs and profile-change propagation semantics | `Required-Core` | `30` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-017` | `DATA-USER-012`,`DATA-D1-002` | `FLOW-CS-PROFILE-PROPAGATION` | `TEST-CS-001` | `EVID-CS-001` | `L1-L3` | profile 真相独立于 account data；`v1.17` client profile surface 还包括 `m.tz` 与 namespaced custom fields；其中只有 `displayname` / `avatar_url` 变更必须传播到 presence 和本地 membership refresh。 |
| `MX-CS-020` | Client-Server | `v1.17` | third-party protocol/user/location lookup, admin `whois` | `Unsupported` | `34`,`40` | `gateway-worker` | `IF-CS-061` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004`,`TEST-GOV-001` | `EVID-CS-004`,`EVID-GOV-001` | `L1-L3` | 当前产品范围不含此管理/身份服务面；公开路由必须 deterministic reject，而不是静默缺失。 |
| `MX-CS-021` | Client-Server | `v1.17` | joined rooms, room alias directory, room directory visibility, room summary | `Stub-Only` | `31`,`34` | `gateway-worker`,`RoomDO`,`jobs-worker`,D1 | `IF-CS-053` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004` | `EVID-CS-004` | `L1-L3` | 包括 `GET /_matrix/client/*/joined_rooms`、`GET/PUT/DELETE /_matrix/client/*/directory/room/{roomAlias}`、`GET /_matrix/client/*/rooms/{roomId}/aliases`、`GET/PUT /_matrix/client/*/directory/list/room/{roomId}`、`GET /_matrix/client/v1/room_summary/{roomIdOrAlias}`；这些都仍是 Matrix `v1.17` current surfaces，这里的 `Stub-Only` 表示显式产品边界，而不是上游 deprecation；在 dedicated contracts 完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开前，不得宣称支持。 |
| `MX-CS-022` | Client-Server | `v1.17` | notifications listing endpoint | `Stub-Only` | `30`,`31` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-054` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004` | `EVID-CS-004` | `L1-L3` | 仅指 `GET /_matrix/client/*/notifications`；`/sync` 中 notification counts 已由 `MX-CS-015` 覆盖；该端点本身仍是 Matrix `v1.17` current surface，这里的 `Stub-Only` 表示显式产品边界，而不是被 `/sync` 计数取代；在 dedicated contracts 完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开前，不得宣称支持。 |
| `MX-CS-023` | Client-Server | `v1.17` | room upgrade | `Stub-Only` | `31` | `gateway-worker`,`RoomDO` | `IF-CS-056` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004` | `EVID-CS-004` | `L1-L3` | 指 `POST /_matrix/client/*/rooms/{roomId}/upgrade`；在 replacement room、state carry-over 与 alias/tombstone 子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开前，不得宣称支持。 |
| `MX-CS-024` | Client-Server | `v1.17` | password change and `m.change_password` capability truth | `Required-Core` | `30`,`40` | `gateway-worker`,`UserDO` | `IF-CS-002`,`IF-CS-006` | `DATA-ID-006`,`DATA-USER-001`,`DATA-USER-002`,`DATA-USER-017` | `FLOW-CS-UIA`,`FLOW-CS-PASSWORD-CHANGE`,`STATE-USER-SESSION`,`STATE-UIA-SESSION` | `TEST-CS-001`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-SEC-001` | `L1-L3` | `GET /capabilities` 必须把 `m.change_password.enabled` 与真实 route truth 对齐；当前基线必须为 `true`。 |
| `MX-CS-025` | Client-Server | `v1.17` | registration/password-reset email and msisdn `requestToken` bootstrap surfaces | `Stub-Only` | `30`,`40` | `gateway-worker` | `IF-CS-007` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004`,`TEST-SEC-002` | `EVID-CS-004`,`EVID-SEC-001` | `L1-L3` | 包括 `/_matrix/client/*/register/{email,msisdn}/requestToken` 与 `/_matrix/client/*/account/password/{email,msisdn}/requestToken`；`L1-L3` 都必须维持 deterministic stub truth；仅在 verification transport、provider trust 与 abuse budget 子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开后，才允许启用完整功能。 |
| `MX-CS-026` | Client-Server | `v1.17` | account deactivation and local erasure baseline | `Required-Core` | `30`,`40` | `gateway-worker`,`UserDO`,`jobs-worker` | `IF-CS-008` | `DATA-ID-006`,`DATA-USER-001`,`DATA-USER-006`,`DATA-USER-007`,`DATA-USER-009`,`DATA-USER-012`,`DATA-USER-013`,`DATA-USER-017` | `FLOW-CS-UIA`,`FLOW-CS-ACCOUNT-DEACTIVATE`,`STATE-USER-SESSION`,`STATE-UIA-SESSION` | `TEST-CS-001`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-SEC-001` | `L1-L3` | 必须原子停用本地登录能力并撤销现有会话；当 `erase = true` 时必须清理本地非事件数据并把未来加入者的本地可见性处理为“尽可能只见 redacted copies”；不得向联邦伪造额外红线事件。 |
| `MX-CS-027` | Client-Server | `v1.17` | OpenID request-token surface for third-party identity delegation | `Unsupported` | `30`,`32`,`40` | `gateway-worker` | `IF-CS-062` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004`,`TEST-GOV-001` | `EVID-CS-004`,`EVID-GOV-001` | `L1-L3` | 指 `POST /_matrix/client/*/user/{userId}/openid/request_token`；当前产品范围不包含 Matrix OpenID delegation 与配套 federation userinfo 面，必须 deterministic reject；未来若要启用，必须由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开。 |
| `MX-CS-028` | Client-Server | `v1.17` | VoIP TURN credential endpoint | `Stub-Only` | `30`,`40` | `gateway-worker` | `IF-CS-063` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004`,`TEST-SEC-002` | `EVID-CS-004`,`EVID-SEC-001` | `L1-L3` | 指 `GET /_matrix/client/*/voip/turnServer`；`L1-L3` 都必须维持 deterministic stub truth；仅在外部 TURN 基础设施、凭据签发策略、TURN trust、secret rotation 与 abuse budget 子规范完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开后，才允许启用完整功能。 |
| `MX-CS-029` | Client-Server | `v1.17` | legacy stream routes and room-preview initial snapshot compatibility surface | `Stub-Only` | `30`,`31` | `gateway-worker` | `IF-CS-064` | `none` | `FLOW-CS-DISABLED-ROUTE` | `TEST-CS-004` | `EVID-CS-004` | `L1-L3` | 包括 `GET /_matrix/client/*/events`、`GET /_matrix/client/*/events/{eventId}`、`GET /_matrix/client/*/initialSync` 与 `GET /_matrix/client/*/rooms/{roomId}/initialSync`；其中前 3 个属于 legacy/deprecated compatibility surface，`GET /rooms/{roomId}/initialSync` 本身不是 deprecated，但在当前项目中仍作为 room-preview compatibility surface 保持 `Stub-Only`；在 dedicated compatibility contracts 完整落地且由新的或替代 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 明示放开前，不得宣称支持。 |

## 5. Federation Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-FED-001` | Server-Server | `v1.17` | server discovery, `/.well-known/matrix/server`, version, server keys | `Required-Core` | `32` | `gateway-worker`,`RemoteServerDO` | `IF-PUB-002`,`IF-FED-001` | `DATA-FED-005`,`DATA-KV-002` | `FLOW-FED-DISCOVERY`,`FLOW-FED-METADATA-SERVE` | `TEST-FED-001` | `EVID-FED-001` | `L2-L3` | 必须兼容 `443`/`8443` Cloudflare 暴露现实。 |
| `MX-FED-002` | Server-Server | `v1.17` | request auth, event signing, ACL interaction boundaries | `Required-Core` | `32`,`40` | `gateway-worker`,`RemoteServerDO`,`RoomDO` | `IF-FED-001`,`IF-FED-002` | `DATA-FED-003`,`DATA-FED-005` | `FLOW-FED-INBOUND-TXN`,`FLOW-FED-OUTBOUND-TXN` | `TEST-FED-001`,`TEST-SEC-001` | `EVID-FED-001`,`EVID-SEC-001` | `L2-L3` | 房间 ACL 和签名验证都必须执行。 |
| `MX-FED-003` | Server-Server | `v1.17` | inbound/outbound transactions, PDU/EDU semantics | `Required-Core` | `32` | `gateway-worker`,`RemoteServerDO`,`RoomDO`,`UserDO` | `IF-FED-002`,`IF-INT-FED-001`,`IF-INT-FED-002` | `DATA-FED-001`,`DATA-FED-002`,`DATA-FED-003`,`DATA-FED-006` | `FLOW-FED-INBOUND-TXN`,`FLOW-FED-OUTBOUND-TXN`,`STATE-REMOTE-SERVER-RETRY` | `TEST-FED-002` | `EVID-FED-001` | `L2-L3` | 对单远端服务器保持稳定顺序与幂等。 |
| `MX-FED-004` | Server-Server | `v1.17` | event/state/auth retrieval, timestamp lookup, backfill, get_missing_events | `Required-Core` | `32`,`31` | `RemoteServerDO`,`RoomDO` | `IF-FED-004` | `DATA-FED-004`,`DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` | `FLOW-FED-STATE-RETRIEVAL-SERVE`,`FLOW-FED-MISSING-EVENT-RECOVERY`,`STATE-ROOM-EVENT-ADMISSION` | `TEST-FED-003` | `EVID-FED-002` | `L2-L3` | 包括 `event`、`event_auth`、`state`、`state_ids`、`timestamp_to_event`、`backfill` 与 `get_missing_events`；修复数据必须重新进入统一准入管道。 |
| `MX-FED-005` | Server-Server | `v1.17` | `make_join` / `send_join` / invite / leave / knock | `Required-Core` | `32`,`31` | `gateway-worker`,`RoomDO`,`RemoteServerDO` | `IF-FED-003` | `DATA-FED-004`,`DATA-ROOM-007` | `FLOW-FED-JOIN-LEAVE`,`STATE-ROOM-MEMBERSHIP` | `TEST-FED-002`,`TEST-ROOM-002` | `EVID-FED-001`,`EVID-ROOM-002` | `L2-L3` | 必须同时覆盖 `v1`/`v2` 的 `send_join` / `invite` / `send_leave` 变体；room version 差异必须稳定适配。 |
| `MX-FED-006` | Server-Server | `v1.17` | federation public room directory, hierarchy, directory query, profile query, generic queries | `Required-Core` | `32`,`34` | `gateway-worker`,`jobs-worker`,`UserDO`,`RoomDO`,D1 | `IF-FED-006` | `DATA-USER-012`,`DATA-D1-003`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007` | `FLOW-FED-QUERY` | `TEST-FED-001`,`TEST-DER-001` | `EVID-FED-001`,`EVID-DER-001` | `L2-L3` | 联邦查询面与 client/repair 面分离；对等价请求时 `publicRooms` 的 `GET`/`POST` 变体必须共用同一可见性裁决真相；目录可走派生面但可见性不确定时必须回退 RoomDO 或拒绝；profile query 只返回 `displayname` / `avatar_url`，未知 generic query type 必须显式拒绝。 |
| `MX-FED-007` | Server-Server | `v1.17` | user devices, user keys query/claim, send-to-device | `Required-Core` | `32`,`30` | `gateway-worker`,`UserDO`,`RemoteServerDO` | `IF-FED-002`,`IF-FED-007`,`IF-FED-008`,`IF-INT-FED-001`,`IF-INT-USER-004` | `DATA-USER-002`,`DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-008`,`DATA-FED-001` | `FLOW-FED-USER-KEYS`,`FLOW-FED-OUTBOUND-TXN` | `TEST-CS-003`,`TEST-FED-002` | `EVID-CS-003`,`EVID-FED-001` | `L2-L3` | 用户域联邦语义不绕过 `UserDO`；`/user/keys/claim` 必须保持 one-time key at-most-once。 |
| `MX-FED-008` | Server-Server | `v1.17` | federation media download / thumbnail | `Required-Core` | `32`,`33` | `gateway-worker`,R2 | `IF-FED-005` | `DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003` | `FLOW-FED-MEDIA-SERVE` | `TEST-MEDIA-002` | `EVID-MEDIA-001` | `L2-L3` | 联邦媒体路由固定为 `GET /_matrix/federation/v1/media/download/{mediaId}` 与 `GET /_matrix/federation/v1/media/thumbnail/{mediaId}`，并要求 `X-Matrix` 鉴权；实现必须受连接与尺寸护栏保护。 |
| `MX-FED-009` | Server-Server | `v1.17` | OpenID userinfo token introspection surface | `Unsupported` | `32`,`40` | `gateway-worker` | `IF-FED-009` | `none` | `FLOW-FED-DISABLED-ROUTE` | `TEST-FED-004`,`TEST-GOV-001` | `EVID-FED-003`,`EVID-GOV-001` | `L2-L3` | 指 `GET /_matrix/federation/*/openid/userinfo`；当前产品范围不包含 Matrix OpenID delegation，对外必须 deterministic `401` + `M_UNKNOWN_TOKEN`。 |
| `MX-FED-010` | Server-Server | `v1.17` | identity-service callback and third-party invite exchange | `Unsupported` | `32`,`40` | `gateway-worker`,`RoomDO` | `IF-FED-010` | `none` | `FLOW-FED-DISABLED-ROUTE` | `TEST-FED-004`,`TEST-GOV-001` | `EVID-FED-003`,`EVID-GOV-001` | `L2-L3` | 包括 `PUT /_matrix/federation/*/3pid/onbind` 与 `PUT /_matrix/federation/*/exchange_third_party_invite/{roomId}`；当前产品范围不包含 identity-service / third-party invite 能力，对外必须 deterministic reject。 |

## 6. Application Service Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-AS-001` | Application Service | `v1.17` | registration model and namespace ownership | `Required-Conditional` | `34` | `ops-worker`,`jobs-worker`,D1 | `IF-OPS-008` | `DATA-D1-005`,`DATA-OPS-004` | `FLOW-OPS-JOB-CONTROL`,`STATE-APPSERVICE-TXN` | `TEST-AS-001` | `EVID-AS-001` | `L3 when appservices enabled` | 首版产品可不开启 appservices；client `/login` `/register` 上的 `m.login.application_service` legacy auth 子集当前仍受 [`OQ-0008`](/root/Matrix/spec/open-questions/OQ-0008.md) 约束，不得被误读成已随 `MX-AS-001` 一并闭合。 |
| `MX-AS-002` | Application Service | `v1.17` | HS->AS transaction delivery | `Required-Conditional` | `34` | `jobs-worker` | `IF-AS-002`,`IF-QUE-003` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY`,`STATE-APPSERVICE-TXN` | `TEST-AS-001` | `EVID-AS-001` | `L3 when appservices enabled` | 每个 appservice 单独有序。 |
| `MX-AS-003` | Application Service | `v1.17` | ping, user/alias/third-party queries, network room directory integration | `Required-Conditional` | `34` | `gateway-worker`,`jobs-worker` | `IF-AS-001`,`IF-AS-002`,`IF-OPS-008` | `DATA-D1-005`,`DATA-D1-003` | `FLOW-AS-TXN-DELIVERY`,`FLOW-OPS-JOB-CONTROL` | `TEST-AS-001` | `EVID-AS-001` | `L3 when appservices enabled` | 依赖控制面配置和目录派生面。 |

## 7. Room Version Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-RV-011` | Room Version | `v1.17` | room version `11` event format, auth, redaction, state resolution | `Required-Core` | `31` | `RoomDO` | `IF-INT-ROOM-001` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` | `FLOW-ROOM-EVENT-ADMISSION` | `TEST-ROOM-002` | `EVID-ROOM-002` | `L2-L3` | 对外开放联邦前必须稳定支持；`TEST/EVID-ROOM-002` 在 `L2-L3` 时必须覆盖 `11` 和 `12`。 |
| `MX-RV-012` | Room Version | `v1.17` | room version `12` event format, room ID, auth, state resolution | `Required-Core` | `31` | `RoomDO` | `IF-INT-ROOM-001` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` | `FLOW-ROOM-EVENT-ADMISSION` | `TEST-ROOM-002` | `EVID-ROOM-002` | `L1-L3` | 新建房间默认版本；`TEST/EVID-ROOM-002` 在 `L1` 时至少覆盖 `12`。 |
| `MX-RV-013` | Room Version | `v1.17` | older stable room versions | `Deferred` | `31` | `RoomDO` | `IF-INT-ROOM-001` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` | `FLOW-ROOM-EVENT-ADMISSION` | `TEST-ROOM-002` | `EVID-ROOM-002` | `L2-L3` | Matrix `v1.17` 仍将这些 room versions 标记为 stable；当前项目之所以保持 `Deferred`，是因为现行联邦 profile 只保证 `11/12`，不宣称对更老稳定版本具备广泛互操作覆盖。若客户端显式请求不支持的 room version，必须返回 `400` + `M_UNSUPPORTED_ROOM_VERSION`；若联邦事件/握手要求不支持的 room version，必须返回 `M_INCOMPATIBLE_ROOM_VERSION` 且不得产生 partial state。只有新增独立 strategy 并通过对应测试门禁后才可支持。 |

## 8. Stub-Only / Unsupported / Deferred Register

本表是由上方 `MX-*` 行派生出的摘要视图；不得与 `MX-*` 正文独立演化。`TEST-GOV-001` 必须把本表与对应 `MX-*` / `OQ-*` / `DEC-*` 一并做一致性校验。

| Surface | Current Status | Related IDs | Rationale |
| --- | --- | --- | --- |
| Legacy stream routes and room-preview initial snapshot compatibility surface | `Stub-Only` | `MX-CS-029`,`DEC-0001` | 当前产品边界已固定为 stub-only；其中 `GET /rooms/{roomId}/initialSync` 仍是 Matrix `v1.17` current surface，但在本项目中与 legacy stream compatibility 一并保持 `Stub-Only`；若要启用，必须先补 dedicated compatibility contracts，并以新的或替代 `DEC-0001` 明示放开。 |
| In-band identity service features | `Stub-Only` | `MX-CS-003`,`MX-CS-005`,`DEC-0001` | 依赖外部 identity integration，不属于本系统内建；当前产品边界固定为 stub-only，只有 dedicated contracts 与新的或替代 `DEC-0001` 后才允许启用。 |
| Push gateway delivery | `Stub-Only` | `MX-CS-016`,`DEC-0001` | 依赖外部 push 基础设施；当前产品边界固定为 stub-only；只有 dedicated contracts 与新的或替代 `DEC-0001` 后才允许启用。 |
| URL preview | `Stub-Only` | `MX-CS-012`,`DEC-0001` | 默认关闭；在 dedicated contracts、隔离抓取器子规范与新的或替代 `DEC-0001` 落地前不得宣称支持。 |
| Reporting APIs | `Stub-Only` | `MX-CS-018`,`DEC-0001` | 当前产品边界固定为 stub-only；未来若启用必须先补齐 abuse workflow 子规范，并以新的或替代 `DEC-0001` 明示放开。 |
| Email/MSISDN requestToken bootstrap | `Stub-Only` | `MX-CS-025`,`DEC-0001` | 依赖可验证的 email / SMS transport、provider trust 与滥用预算；当前产品边界固定为 stub-only；只有新的或替代 `DEC-0001` 才可放开。 |
| OpenID request-token delegation | `Unsupported` | `MX-CS-027`,`DEC-0001` | 当前产品范围不含该第三方身份委托面；当前只允许 deterministic reject；未来若要启用，必须以新的或替代 `DEC-0001` 明示放开。 |
| VoIP TURN credentials | `Stub-Only` | `MX-CS-028`,`DEC-0001` | 依赖外部 TURN 基础设施与凭据轮换；当前产品边界固定为 stub-only；只有 dedicated contracts 与新的或替代 `DEC-0001` 后才允许启用。 |
| Federation OpenID userinfo | `Unsupported` | `MX-FED-009` | 当前产品范围不含 Matrix OpenID delegation 的联邦对偶面；当前只允许 deterministic `401` + `M_UNKNOWN_TOKEN`。 |
| Federation 3PID callback / third-party invite exchange | `Unsupported` | `MX-FED-010` | 当前产品范围不含 identity-service callback 与 third-party invite 联邦握手；当前只允许 deterministic reject。 |
| Joined rooms / room alias directory / room summary | `Stub-Only` | `MX-CS-021`,`DEC-0001` | 这些仍是 Matrix `v1.17` current surfaces；当前产品边界固定为 stub-only，而不是声称它们已被上游废弃；未来若启用必须先补 dedicated contracts，并以新的或替代 `DEC-0001` 明示放开。 |
| Notifications listing endpoint | `Stub-Only` | `MX-CS-022`,`DEC-0001` | `/sync` 计数不等于 `/notifications` 列表语义；该端点仍是 Matrix `v1.17` current surface，当前产品边界只是把它固定为 stub-only；只有新的或替代 `DEC-0001` 才可放开。 |
| Older stable room versions beyond `11/12` | `Deferred` | `MX-RV-013` | Matrix `v1.17` 仍将这些版本标为 stable，但当前联邦 profile 只保证 `11/12`；在独立 strategy、测试与发布门禁落地前，不宣称对更老稳定版本具备广泛互操作覆盖。 |
| Room upgrade | `Stub-Only` | `MX-CS-023`,`DEC-0001` | replacement room 与迁移语义尚未钉死；当前产品边界固定为 stub-only；未来若启用必须先补 dedicated contracts，并以新的或替代 `DEC-0001` 明示放开。 |
| Third-party lookup and admin `whois` surfaces | `Unsupported` | `MX-CS-020` | 不在当前产品范围；当前只允许 deterministic reject。 |

## 9. 合规声明规则

* 只有当目标 profile 下全部 `Required-Core` 条目通过其映射的 `TEST-ID` 与 `EVID-ID`，且满足 [43-testing-and-compliance.md](/root/Matrix/spec/framework/43-testing-and-compliance.md) 与 [44-verification-and-evidence-register.md](/root/Matrix/spec/framework/44-verification-and-evidence-register.md) 的 profile 级额外门禁时，才可宣称对该 profile 合规。
* `Required-Conditional` 的 full feature 只有在功能开关启用时才进入对应功能门禁范围；但若该条目在当前 profile 规定了 deterministic disabled / stub truth，则该 disabled truth 仍必须进入当前 profile 的 `TEST-ID` / `EVID-ID` 门禁。
* `Stub-Only` 条目在当前 profile 下必须通过 deterministic stub / disabled truth 的 `TEST-ID` / `EVID-ID` 门禁；在新的或替代 `DEC-ID` 放开前，不得把 feature flag、局部 handler 或 capability 声明视为 full feature 发布授权。
* 对 [DEC-0001](/root/Matrix/spec/decisions/DEC-0001.md) 覆盖的 `MX-ID`，上一条中的“功能开关启用”不构成 full feature 发布授权；必须同时满足 dedicated sub-spec 完整落地与新的或替代 `DEC-ID` 明示放开。
* `Deferred`、`Stub-Only`、`Unsupported` 条目必须对外有明确行为，不得静默缺失。

## 10. 完成标准

* 当前 profile 的协议边界已明确；
* 每个主要协议族已有唯一主责分册和运行时落位；
* 已知 conditional / deferred / unsupported 面均已显式记录；
* 后续可以继续补齐 endpoint 级 `MX-ID` 而不改变当前大边界。
