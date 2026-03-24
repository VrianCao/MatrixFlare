# Matrix Protocol Compliance Profile

状态：Outline  
角色：Matrix 覆盖矩阵分册  
负责主文档章节：1，4，7  
扩展范围：全部 Matrix 协议面

## 1. 文档职责

* 为 Matrix 协议实现建立完整覆盖矩阵。
* 规定每个协议面、接口组、事件类型、房间版本规则在本项目中的支持级别。
* 规定每个协议 requirement 的唯一 owning spec、runtime component、test 和 evidence。
* 为“完全符合规范”的声明建立可审计基础。

明确不包含：

* 不代替各责任分册展开正文；
* 不直接定义 Cloudflare 平台限制；
* 不代替测试分册设计测试策略。

## 2. 覆盖条目模型

每个覆盖条目至少需要包含以下字段：

* `MX-ID`
* 协议家族
* 上游规范版本与章节
* 端点 / 事件 / 行为 / 房间版本特性
* 适用条件
* 支持级别
* Owning spec
* Owning runtime component
* Interface contract IDs
* Data contract IDs
* Flow / State IDs
* Test IDs
* Evidence IDs
* 发布 profile
* 备注 / 偏差说明

### 2.1 标准表头

| MX-ID | Protocol Family | Spec Version | Spec Section | Surface | Applicability | Support Level | Owning Spec | Runtime Owner | IF IDs | DATA IDs | FLOW/STATE IDs | TEST IDs | EVID IDs | Release Profile | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MX-... | Client-Server / Server-Server / AS / Room Version | v1.17 | exact section | endpoint / event / rule | always / conditional | Required-Core | `30-34/40-43` | gateway / `RoomDO` / `UserDO` / `RemoteServerDO` / jobs | `IF-*` | `DATA-*` | `FLOW-*` / `STATE-*` | `TEST-*` | `EVID-*` | `Profile-*` | deviation / rationale |

### 2.2 颗粒度规则

* 每个端点必须至少有一行。
* 每个跨端点语义规则若不能由单端点完整表达，必须单独成行。
* 每个房间版本特性差异必须单独成行。
* 不允许把多个不同行为合并成一个模糊覆盖条目。

## 3. 支持级别枚举

* `Required-Core`：GA 前必须完整支持。
* `Required-Conditional`：在功能域开启时必须完整支持。
* `Deferred`：本阶段未实现，但必须记录原因与阻塞。
* `Unsupported`：明确不支持，必须说明边界与对外行为。
* `Not-Applicable`：与本项目范围无关。
* `Experimental`：仅实验，不可纳入 GA 真相。

## 4. 发布 Profile 维度

* `Profile-L0-Doc-System`
* `Profile-L1-Local-Core`
* `Profile-L2-Federation-Core`
* `Profile-L3-Enterprise-Hardening`

同一条协议 requirement 可以在不同 profile 下拥有不同支持状态，但必须明确升级路径。

## 5. Client-Server API 覆盖分组

### 5.1 Baseline and Discovery

* API standards
* Server discovery
* `/.well-known/matrix/client`
* `/_matrix/client/versions`

### 5.2 Client Authentication and Session Lifecycle

* Login
* Registration
* Registration token validity
* Access token refresh
* Logout / logout all
* SSO redirect
* Auth metadata

### 5.3 Account and Identity Data

* Password management
* Deactivation
* 3PID operations
* `whoami`
* Account data
* Tags
* Ignored users
* Direct rooms

### 5.4 Capabilities and Filters

* Capabilities negotiation
* Filters

### 5.5 Sync, Timeline, Event Retrieval

* `/sync`
* `/events`
* Event by ID
* Room event by ID
* Room context
* Room messages
* Timestamp to event
* Relations
* Initial sync legacy behavior

### 5.6 Room Lifecycle and Membership

* Create room
* Room directory alias APIs
* Joined rooms
* Invite
* Join
* Knock
* Leave
* Forget
* Kick / ban / unban
* Joined members / members
* Room summary

### 5.7 Room State and Event Send

* Room state get / put
* Send event
* Redaction
* Canonical room state events required by room versions

### 5.8 Ephemeral and Per-Room User Signals

* Typing
* Receipts
* Read markers
* Marked unread
* Presence

### 5.9 Media Repository

* Media config
* Upload create / upload
* Download
* Thumbnail
* URL preview

### 5.10 Devices and To-Device Messaging

* Device list
* Device detail / update / delete
* Bulk device deletion
* Send-to-device

### 5.11 E2EE and Secret Storage Related APIs

* Key upload / query / claim / changes
* Device signing
* Signature upload
* Room key backup lifecycle
* Secret request / send
* Verification message families

### 5.12 Push, Notifications, Search, Reporting

* Push rules
* Pushers
* Notifications
* Search
* Reporting APIs
* User directory search
* Admin `whois` if in scope

### 5.13 Profile and Third-Party Lookups

* Profile APIs
* Third-party location / user lookups

## 6. Server-Server API 覆盖分组

### 6.1 Discovery, Version, Keys

* `/.well-known/matrix/server`
* Federation version
* Server key retrieval and query

### 6.2 Authentication and Signing

* Request authentication
* Event signing
* ACL interaction boundaries

### 6.3 Transactions

* Inbound `send`
* EDU and PDU handling semantics

### 6.4 Event Retrieval and State

* Event auth
* Backfill
* Get missing events
* Event by ID
* State
* State IDs
* Timestamp to event

### 6.5 Room Join / Invite / Leave / Knock

* `make_join` / `send_join`
* `make_knock` / `send_knock`
* Invite v1 / v2
* `make_leave` / `send_leave`

### 6.6 Directory, Hierarchy, Queries

* Public rooms
* Space hierarchy
* Directory query
* Profile query
* Generic query endpoints
* OpenID userinfo

### 6.7 Devices, E2EE, To-Device

* User devices
* User keys claim / query
* Send-to-device semantics

### 6.8 Federation Media

* Media download
* Media thumbnail

## 7. Application Service API 覆盖分组

### 7.1 Registration and Namespace Model

### 7.2 Transaction Delivery

### 7.3 Ping and Health

### 7.4 User / Alias / Third-Party Query Endpoints

### 7.5 Network-scoped Room Directory Integration

## 8. Room Version Coverage

### 8.1 Room Version Baseline Matrix

每个目标房间版本至少需要覆盖：

* Event format
* Event ID rules
* Redaction rules
* Canonical JSON and signatures
* Auth rules
* Power level interpretation
* Join rules and restricted join semantics
* Knocking support
* Notification count semantics
* State resolution requirements

### 8.2 Supported Versions Register

* Default room version
* Stable compatibility versions
* Rejected / unsupported versions
* Upgrade and migration strategy

## 9. 追溯与发布规则

* 任何实现声明都必须先落为覆盖条目。
* 任何覆盖条目都必须指向 owning spec、contract、test、evidence。
* 任何 `Deferred` 或 `Unsupported` 条目都必须有用户可感知边界说明。

## 10. 完成标准

* Matrix 责任面无遗漏；
* 每个协议 requirement 都有唯一归属；
* 支持边界、延后边界、非适用边界清晰；
* 可直接用于协议合规审查与发布门禁。
