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
* 当前观察到的 `latest`：`2026-03-24` 时为 `v1.17`。
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

### 2.4 支持级别枚举

* `Required-Core`：该 profile 下必须实现并通过门禁。
* `Required-Conditional`：当对应功能开关启用时必须完整实现。
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
| `MX-CS-001` | Client-Server | `v1.17` | discovery, `/.well-known/matrix/client`, `/versions` | `Required-Core` | `30` | `gateway-worker` | `IF-PUB-001`,`IF-CS-001` | `DATA-KV-001` | `FLOW-CS-DISCOVERY` | `TEST-CS-001` | `EVID-CS-001` | `L1-L3` | 基线发现与能力声明。 |
| `MX-CS-002` | Client-Server | `v1.17` | registration, login, refresh, logout, `whoami` | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-010`-`014` | `DATA-USER-001`,`DATA-ID-003`,`DATA-ID-004` | `FLOW-CS-REGISTER`,`FLOW-CS-LOGIN`,`FLOW-CS-REFRESH`,`STATE-USER-SESSION` | `TEST-CS-001`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-SEC-001` | `L1-L3` | 不含 SSO。 |
| `MX-CS-003` | Client-Server | `v1.17` | SSO redirect and identity-provider login | `Required-Conditional` | `30`,`40` | `gateway-worker`,`UserDO` | route family reserved | session contracts | session flows | `TEST-CS-001`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-SEC-001` | `L3 when enabled` | 未启用时不宣称支持。 |
| `MX-CS-004` | Client-Server | `v1.17` | account data, tags, ignored users, direct rooms | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-015` | `DATA-USER-006`,`DATA-USER-007`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-002` | `EVID-CS-002` | `L1-L3` | 所有变更必须进入用户流。 |
| `MX-CS-005` | Client-Server | `v1.17` | 3PID bind/unbind and identity-service-assisted flows | `Required-Conditional` | `30`,`40` | `gateway-worker`,`UserDO` | reserved | reserved | reserved | `TEST-CS-001`,`TEST-SEC-001` | `EVID-CS-001`,`EVID-SEC-001` | `L3 when external identity integration enabled` | 本系统不内建 Identity Service。 |
| `MX-CS-006` | Client-Server | `v1.17` | capabilities, filter create/get, and filter application to `/sync` | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-002`,`IF-CS-003`,`IF-CS-004`,`IF-CS-020` | `DATA-ID-001`,`DATA-USER-014` | `FLOW-CS-DISCOVERY`,`FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-001`,`TEST-CS-002` | `EVID-CS-001`,`EVID-CS-002` | `L1-L3` | capability 声明与实际写权限、filter 解析行为必须一致。 |
| `MX-CS-007` | Client-Server | `v1.17` | `/sync` initial/incremental/long-poll/`use_state_after` | `Required-Core` | `30` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-020`,`IF-INT-USER-002`,`IF-INT-ROOM-002` | `DATA-ID-001`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL`,`STATE-SYNC-WAITER` | `TEST-CS-002` | `EVID-CS-002` | `L1-L3` | 由 Worker 持有长轮询；`L3` 另外受 `TEST-PERF-001`/`EVID-PERF-001` 约束。 |
| `MX-CS-008` | Client-Server | `v1.17` | room creation, membership, pagination, event retrieval | `Required-Core` | `31` | `gateway-worker`,`RoomDO`,`UserDO` | `IF-CS-030`,`IF-CS-031`,`IF-CS-034` | `DATA-ROOM-001`-`010` | `FLOW-CS-ROOM-MEMBERSHIP`,`FLOW-CS-SEND-EVENT`,`STATE-ROOM-MEMBERSHIP` | `TEST-ROOM-001`,`TEST-ROOM-002` | `EVID-ROOM-001`,`EVID-ROOM-002` | `L1-L3` | 包括 join/invite/leave/knock/forget 的本地语义。 |
| `MX-CS-009` | Client-Server | `v1.17` | room state send/get, timeline event send, redaction | `Required-Core` | `31` | `gateway-worker`,`RoomDO` | `IF-CS-032`,`IF-CS-033`,`IF-CS-034` | `DATA-ROOM-001`-`008` | `FLOW-ROOM-EVENT-ADMISSION`,`STATE-ROOM-EVENT-ADMISSION` | `TEST-ROOM-001`,`TEST-ROOM-002` | `EVID-ROOM-001`,`EVID-ROOM-002` | `L1-L3` | room version 差异由 strategy 层裁决。 |
| `MX-CS-010` | Client-Server | `v1.17` | typing, receipts, read markers, presence | `Required-Core` | `30`,`31` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-015`,`IF-CS-016`,`IF-CS-020` | `DATA-ROOM-009`,`DATA-ROOM-010`,`DATA-USER-009`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-002`,`TEST-ROOM-001` | `EVID-CS-002`,`EVID-ROOM-001` | `L1-L3` | ephemeral 失败不得污染 timeline truth。 |
| `MX-CS-011` | Client-Server | `v1.17` | media config, upload, download, thumbnail | `Required-Core` | `33` | `gateway-worker`,`UserDO`,R2 | `IF-CS-050`,`IF-CS-051` | `DATA-R2-001`,`DATA-R2-003`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD`,`FLOW-CS-MEDIA-DOWNLOAD` | `TEST-MEDIA-001` | `EVID-MEDIA-001` | `L1-L3` | 受 Cloudflare request body limit 约束。 |
| `MX-CS-012` | Client-Server | `v1.17` | URL preview | `Required-Conditional` | `33`,`40` | isolated preview worker | reserved | cache-only preview data | reserved | `TEST-SEC-002` | `EVID-SEC-001` | `L3 when enabled` | 默认关闭。 |
| `MX-CS-013` | Client-Server | `v1.17` | devices, to-device messaging | `Required-Core` | `30` | `gateway-worker`,`UserDO` | `IF-CS-040`,`IF-CS-041` | `DATA-USER-002`,`DATA-USER-008`,`DATA-USER-010` | `FLOW-CS-SEND-TO-DEVICE`,`STATE-DEVICE-LIFECYCLE` | `TEST-CS-003` | `EVID-CS-003` | `L1-L3` | 每目标设备的投递必须线性化。 |
| `MX-CS-014` | Client-Server | `v1.17` | E2EE transport: keys upload/query/claim, cross-signing, backup | `Required-Core` | `30` | `gateway-worker`,`UserDO`,R2 | `IF-CS-042`-`045`,`IF-INT-USER-004` | `DATA-USER-003`,`004`,`005`,`011`,`DATA-R2-006` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-003` | `EVID-CS-003` | `L1-L3` | homeserver 只负责传输与存储边界。 |
| `MX-CS-015` | Client-Server | `v1.17` | push rules, unread counters, and notification counts in `/sync` | `Required-Core` | `30`,`31` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-018`,`IF-CS-020` | `DATA-USER-013`,`DATA-USER-010`,`DATA-USER-006`,`DATA-USER-007`,`DATA-ROOM-007`,`DATA-ROOM-009` | `FLOW-CS-SYNC-LONGPOLL` | `TEST-CS-002` | `EVID-CS-002` | `L1-L3` | 默认规则来自 Matrix `v1.17`；只把用户覆盖持久化。 |
| `MX-CS-016` | Client-Server | `v1.17` | pushers and external push gateway integration | `Required-Conditional` | `30`,`40` | `gateway-worker`,`UserDO` | reserved | reserved | reserved | `TEST-SEC-002` | `EVID-SEC-001` | `L3 when enabled` | 本系统不内建 Push Gateway。 |
| `MX-CS-017` | Client-Server | `v1.17` | search, user directory, public rooms, client hierarchy | `Required-Core` | `34` | `gateway-worker`,`jobs-worker`,D1 | `IF-CS-052`,`IF-QUE-001` | `DATA-D1-001`,`002`,`003` | `FLOW-SEARCH-INDEX` | `TEST-DER-001` | `EVID-DER-001` | `L1-L3` | 派生面最终一致；`L3` 另外受 `TEST-OPS-002`/`EVID-OPS-002` 恢复门禁约束。 |
| `MX-CS-018` | Client-Server | `v1.17` | reporting APIs and abuse-report submission | `Deferred` | `40` | `gateway-worker`,`ops-worker` | reserved | reserved | reserved | `TEST-SEC-002` | `EVID-SEC-001` | `L3 target` | 需补齐运维处置流程后才能 GA。 |
| `MX-CS-019` | Client-Server | `v1.17` | profile APIs and profile-change propagation semantics | `Required-Core` | `30` | `gateway-worker`,`UserDO`,`RoomDO` | `IF-CS-017` | `DATA-USER-012`,`DATA-D1-002` | `FLOW-CS-PROFILE-PROPAGATION` | `TEST-CS-001` | `EVID-CS-001` | `L1-L3` | profile 真相独立于 account data；`displayname`/`avatar_url` 变更必须传播到 presence 和本地 membership refresh。 |
| `MX-CS-020` | Client-Server | `v1.17` | third-party user/location lookup, admin `whois` | `Unsupported` | `40` | n/a | none | none | none | `TEST-GOV-001` | `EVID-GOV-001` | `L1-L3` | 当前产品范围不含此管理/身份服务面。 |

## 5. Federation Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-FED-001` | Server-Server | `v1.17` | server discovery, `/.well-known/matrix/server`, version, server keys | `Required-Core` | `32` | `gateway-worker`,`RemoteServerDO` | `IF-PUB-002`,`IF-FED-001` | `DATA-FED-005`,`DATA-KV-002` | `FLOW-FED-DISCOVERY` | `TEST-FED-001` | `EVID-FED-001` | `L2-L3` | 必须兼容 `443`/`8443` Cloudflare 暴露现实。 |
| `MX-FED-002` | Server-Server | `v1.17` | request auth, event signing, ACL interaction boundaries | `Required-Core` | `32`,`40` | `gateway-worker`,`RemoteServerDO`,`RoomDO` | `IF-FED-001`,`IF-FED-002` | `DATA-FED-003`,`DATA-FED-005` | `FLOW-FED-INBOUND-TXN`,`FLOW-FED-OUTBOUND-TXN` | `TEST-FED-001`,`TEST-SEC-001` | `EVID-FED-001`,`EVID-SEC-001` | `L2-L3` | 房间 ACL 和签名验证都必须执行。 |
| `MX-FED-003` | Server-Server | `v1.17` | inbound/outbound transactions, PDU/EDU semantics | `Required-Core` | `32` | `gateway-worker`,`RemoteServerDO`,`RoomDO`,`UserDO` | `IF-FED-002`,`IF-INT-FED-001`,`IF-INT-FED-002` | `DATA-FED-001`,`002`,`003` | `FLOW-FED-INBOUND-TXN`,`FLOW-FED-OUTBOUND-TXN`,`STATE-REMOTE-SERVER-RETRY` | `TEST-FED-002` | `EVID-FED-001` | `L2-L3` | 对单远端服务器保持稳定顺序与幂等。 |
| `MX-FED-004` | Server-Server | `v1.17` | event/state retrieval, backfill, get_missing_events | `Required-Core` | `32`,`31` | `RemoteServerDO`,`RoomDO` | `IF-FED-004` | `DATA-FED-004`,`DATA-ROOM-001`-`008` | `FLOW-FED-MISSING-EVENT-RECOVERY`,`STATE-ROOM-EVENT-ADMISSION` | `TEST-FED-003` | `EVID-FED-002` | `L2-L3` | 修复数据必须重新进入统一准入管道。 |
| `MX-FED-005` | Server-Server | `v1.17` | `make_join` / `send_join` / invite / leave / knock | `Required-Core` | `32`,`31` | `gateway-worker`,`RoomDO`,`RemoteServerDO` | `IF-FED-003` | `DATA-FED-004`,`DATA-ROOM-007` | `FLOW-FED-JOIN-LEAVE`,`STATE-ROOM-MEMBERSHIP` | `TEST-FED-002`,`TEST-ROOM-002` | `EVID-FED-001`,`EVID-ROOM-002` | `L2-L3` | room version 差异必须稳定适配。 |
| `MX-FED-006` | Server-Server | `v1.17` | federation hierarchy, directory query, profile query, generic queries | `Required-Conditional` | `32`,`34` | `gateway-worker`,`jobs-worker`,`UserDO`,`RoomDO`,D1 | `IF-FED-006` | `DATA-USER-012`,`DATA-D1-003`,`DATA-ROOM-005`-`007` | `FLOW-FED-QUERY` | `TEST-FED-001`,`TEST-DER-001` | `EVID-FED-001`,`EVID-DER-001` | `L2-L3 when feature enabled` | 联邦查询面与 client/repair 面分离；目录可走派生面但可见性不确定时必须回退 RoomDO 或拒绝；profile query 只返回 `displayname` / `avatar_url`。 |
| `MX-FED-007` | Server-Server | `v1.17` | user devices, user keys query/claim, send-to-device | `Required-Core` | `32`,`30` | `gateway-worker`,`UserDO`,`RemoteServerDO` | `IF-FED-002`,`IF-INT-FED-001`,`IF-INT-USER-004` | `DATA-USER-003`,`004`,`005`,`008`,`DATA-FED-001` | `FLOW-FED-OUTBOUND-TXN` | `TEST-CS-003`,`TEST-FED-002` | `EVID-CS-003`,`EVID-FED-001` | `L2-L3` | 用户域联邦语义不绕过 `UserDO`。 |
| `MX-FED-008` | Server-Server | `v1.17` | federation media download / thumbnail | `Required-Core` | `32`,`33` | `gateway-worker`,R2 | `IF-FED-005` | `DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003` | `FLOW-CS-REMOTE-MEDIA-FETCH` | `TEST-MEDIA-002` | `EVID-MEDIA-001` | `L2-L3` | 远端媒体 miss 必须受连接与尺寸护栏保护。 |

## 6. Application Service Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-AS-001` | Application Service | `v1.17` | registration model and namespace ownership | `Required-Conditional` | `34` | `ops-worker`,`jobs-worker`,D1 | `IF-AS-001` | `DATA-D1-005` | `STATE-APPSERVICE-TXN` | `TEST-AS-001` | `EVID-AS-001` | `L3 when appservices enabled` | 首版产品可不开启 appservices。 |
| `MX-AS-002` | Application Service | `v1.17` | HS->AS transaction delivery | `Required-Conditional` | `34` | `jobs-worker` | `IF-AS-002`,`IF-QUE-003` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY`,`STATE-APPSERVICE-TXN` | `TEST-AS-001` | `EVID-AS-001` | `L3 when appservices enabled` | 每个 appservice 单独有序。 |
| `MX-AS-003` | Application Service | `v1.17` | ping, user/alias/third-party queries, network room directory integration | `Required-Conditional` | `34` | `gateway-worker`,`jobs-worker` | `IF-AS-001`,`IF-AS-002` | `DATA-D1-005`,`DATA-D1-003` | `FLOW-AS-TXN-DELIVERY` | `TEST-AS-001` | `EVID-AS-001` | `L3 when appservices enabled` | 依赖控制面配置和目录派生面。 |

## 7. Room Version Coverage

| MX-ID | Protocol Family | Spec Version | Surface | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MX-RV-011` | Room Version | `v1.17` | room version `11` event format, auth, redaction, state resolution | `Required-Core` | `31` | `RoomDO` | `IF-INT-ROOM-001` | `DATA-ROOM-001`-`008` | `FLOW-ROOM-EVENT-ADMISSION` | `TEST-ROOM-002` | `EVID-ROOM-002` | `L2-L3` | 对外开放联邦前必须稳定支持；`TEST/EVID-ROOM-002` 在 `L2-L3` 时必须覆盖 `11` 和 `12`。 |
| `MX-RV-012` | Room Version | `v1.17` | room version `12` event format, room ID, auth, state resolution | `Required-Core` | `31` | `RoomDO` | `IF-INT-ROOM-001` | `DATA-ROOM-001`-`008` | `FLOW-ROOM-EVENT-ADMISSION` | `TEST-ROOM-002` | `EVID-ROOM-002` | `L1-L3` | 新建房间默认版本；`TEST/EVID-ROOM-002` 在 `L1` 时至少覆盖 `12`。 |
| `MX-RV-013` | Room Version | `v1.17` | older stable room versions | `Deferred` | `31` | `RoomDO` | reserved | reserved | reserved | `TEST-ROOM-002` | `EVID-ROOM-002` | `future profile` | 只有新增 strategy 后才可支持。 |

## 8. Unsupported / Deferred Register

| Surface | Current Status | Rationale |
| --- | --- | --- |
| Legacy initial sync and deprecated event stream routes | `Deferred` | 进入 `Normative` 前需逐端点评估是否仍需兼容。 |
| In-band identity service features | `Required-Conditional` | 依赖外部 identity integration，不属于本系统内建。 |
| Push gateway delivery | `Required-Conditional` | 依赖外部 push 基础设施。 |
| URL preview | `Required-Conditional` | 默认关闭，需单独 SSRF 与资源隔离。 |
| Admin-specific `whois` style surfaces | `Unsupported` | 不在当前产品范围。 |

## 9. 合规声明规则

* 只有当目标 profile 下全部 `Required-Core` 条目通过其映射的 `TEST-ID` 与 `EVID-ID`，且满足 [43-testing-and-compliance.md](/root/Matrix/spec/framework/43-testing-and-compliance.md) 与 [44-verification-and-evidence-register.md](/root/Matrix/spec/framework/44-verification-and-evidence-register.md) 的 profile 级额外门禁时，才可宣称对该 profile 合规。
* `Required-Conditional` 只有在功能开关启用时才进入门禁范围。
* `Deferred`、`Unsupported` 条目必须对外有明确行为，不得静默缺失。

## 10. 完成标准

* 当前 profile 的协议边界已明确；
* 每个主要协议族已有唯一主责分册和运行时落位；
* 已知 conditional / deferred / unsupported 面均已显式记录；
* 后续可以继续补齐 endpoint 级 `MX-ID` 而不改变当前大边界。
