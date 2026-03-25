# Governance and References Spec

状态：Draft-Normative
角色：基础治理分册
负责主文档章节：1
继承的单体章节：1-5

## 1. 文档职责

* 固定文档状态、版本、读者、阅读顺序。
* 固定项目范围、目标、非目标、产品假设。
* 固定 Matrix 与 Cloudflare 的规范引用边界。
* 固定事实来源与后续追溯规则。
* 作为 `11-14` 治理控制分册的总入口。

明确不包含：

* 不展开运行时架构；
* 不展开协议实现；
* 不展开部署、迁移、性能、成本正文。

## 2. 文档控制

### 2.1 当前包状态

* 当前文档系统目标：定义一个运行于 Cloudflare Workers Paid Plan 的 Matrix homeserver 企业级 Development Spec。
* 当前实现基线观察日期：`2026-03-25`。
* 在本文档系统内，任何标记为 `Draft-Normative` 或 `Normative` 的分册，都是其责任边界内的实现真相。
* `research/`、`notes/`、遗留单体 Spec 仅作为输入材料，不是现行真相。

### 2.2 当前治理基线

| Governance Item | Value |
| --- | --- |
| Workspace boundary | `/root/Matrix` |
| Product scope | 单个 Matrix homeserver |
| Cloudflare plan assumption | Workers Paid |
| Tenancy assumption | 单部署单租户 |
| Matrix observed latest on observation date | `v1.17` |
| Current implementation baseline target | Matrix `v1.17` |

## 3. 范围、目标与非目标

### 3.1 范围

本 Spec 覆盖：

* Matrix homeserver
* Client-Server API
* Server-Server API
* Application Service API
* 房间处理、联邦、媒体、目录、搜索、E2EE 传输
* Cloudflare Workers、Durable Objects、D1、R2、KV、Queues、Service Bindings、DO Alarms

### 3.2 目标

* 在 Cloudflare 已公开、已验证的产品边界内实现 homeserver。
* 使开发团队可以仅凭 Spec 直接拆分模块、建立 schema、实现 runtime 与测试。
* 把 Matrix 协议语义与 Cloudflare 平台事实都显式落在可追溯文档中。

### 3.3 非目标

* 不把 Identity Service 作为本系统内建部分。
* 不把 Push Gateway、TURN、独立通知基础设施作为首版内建一部分。
* 不在同一状态平面内承载多租户多 homeserver 域名。
* 不把 D1 或 KV 作为房间/用户权威真相。

## 4. 产品与部署假设

| REQ-ID | Assumption | Normative Statement |
| --- | --- | --- |
| `REQ-GOV-001` | Single-homeserver deployment | 一个部署环境只服务一个 homeserver 域名。 |
| `REQ-GOV-002` | Single-tenant state plane | 首版不支持同一部署内多租户混用同一状态平面。 |
| `REQ-GOV-003` | Workers Paid baseline | 所有成本、容量和运行时判断都基于 Workers Paid。 |
| `REQ-GOV-004` | Explicit compatibility control | 所有 Worker 都必须设置显式 `compatibility_date` 并在验证后推进。 |
| `REQ-GOV-005` | Staging required | 生产前必须存在独立 staging 环境。 |
| `REQ-GOV-006` | R2 export required | 生产必须具备到 R2 的导出与恢复演练能力。 |

## 5. 读者与阅读顺序

### 5.1 目标读者

* 架构师
* Worker / DO 开发
* 协议开发
* SRE / 平台工程
* 安全工程
* QA / 合规测试工程

### 5.2 阅读顺序

1. `10-15`：先理解范围、权威、协议覆盖、平台约束、追溯规则与来源观察寄存器。
2. `20-25`：再理解系统上下文、运行时拓扑、数据、一致性、接口、流程。
3. `30-34`：再进入具体责任域实现。
4. `40-44`：最后收敛到安全、观测、交付、测试、证据。

## 6. 规范引用

### 6.1 Matrix 基线

本项目的协议基线是 Matrix `v1.17` 版本化规范。必须使用的上游资料包括：

* `https://spec.matrix.org/v1.17/client-server-api/`
* `https://spec.matrix.org/v1.17/server-server-api/`
* `https://spec.matrix.org/v1.17/application-service-api/`
* `https://spec.matrix.org/v1.17/rooms/`
* `https://spec.matrix.org/v1.17/rooms/v11/`
* `https://spec.matrix.org/v1.17/rooms/v12/`

`https://spec.matrix.org/latest/` 只用于变更监测，不作为未锁定实现基线。

### 6.2 Cloudflare 基线

Cloudflare 平台事实必须来自官方文档，并先进入 [13-cloudflare-platform-constraint-register.md](/root/Matrix/spec/framework/13-cloudflare-platform-constraint-register.md)。必须使用的来源族包括：

* Workers pricing / limits / versions & deployments / placement / secrets
* Durable Objects pricing / limits / lifecycle / migrations / SQLite storage / websockets
* D1 pricing / limits / read replication
* KV consistency
* R2 pricing / limits / consistency
* Queues pricing
* Network ports

### 6.3 本地快照

`research/sources/` 中的页面快照是本次文档编写的本地研究缓存。任何正文结论必须重新写入当前框架，并回链到对应 `MX-ID` 或 `CF-ID`。

## 7. Source Traceability Policy

* 所有 Matrix 语义断言必须回链到 Matrix versioned spec 或 `MX-ID`。
* 所有 Cloudflare 平台断言必须回链到 Cloudflare 官方资料或 `CF-ID`。
* 所有内部实现断言必须回链到 `REQ-ID`、主责分册、接口契约、数据契约、流程图或状态机。

## 8. 治理控制栈入口

| Control Doc | Responsibility |
| --- | --- |
| [11-spec-authority-and-version-policy.md](/root/Matrix/spec/framework/11-spec-authority-and-version-policy.md) | 定义文档权威层级、版本锁定和变更准入 |
| [12-matrix-protocol-compliance-profile.md](/root/Matrix/spec/framework/12-matrix-protocol-compliance-profile.md) | 定义 Matrix 支持面、覆盖矩阵和 release profile |
| [13-cloudflare-platform-constraint-register.md](/root/Matrix/spec/framework/13-cloudflare-platform-constraint-register.md) | 定义 Cloudflare 平台事实、限制和计费边界 |
| [14-traceability-and-change-control.md](/root/Matrix/spec/framework/14-traceability-and-change-control.md) | 定义 requirement/contract/test/evidence 闭环和变更包要求 |

## 9. 完成标准

* 范围边界没有歧义；
* 规范引用范围可追溯；
* 假设条件可验证；
* `11-14` 的治理职责已正确挂接；
* 其他分册可以直接继承本册约束继续填充。
