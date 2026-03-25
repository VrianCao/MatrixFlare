# Master Spec Outline

状态：Outline  
角色：主文档骨架  
范围：只定义顶层章节树、阅读顺序、分册归属、后续回填入口

## 1. 主文档职责

主文档后续只承担以下职责：

* 定义项目状态、范围、目标读者与阅读顺序；
* 说明整体架构轮廓与全局不变量；
* 建立单体章节到分册的归属关系；
* 统一引用所有分册的摘要、接口边界与验收门槛；
* 作为开发团队进入整套 Spec 的第一入口。

主文档后续不承担以下职责：

* 不展开协议域正文；
* 不承载完整平台细节；
* 不作为唯一实现细节来源；
* 不替代分册内的表、图、状态机、规则矩阵。

## 2. 顶层章节树

### 1. Document Control and Scope

主责分册：`10-governance-and-references.md`、`11-spec-authority-and-version-policy.md`、`12-matrix-protocol-compliance-profile.md`、`13-cloudflare-platform-constraint-register.md`、`14-traceability-and-change-control.md`

### 2. Executive Summary and Architecture Overview

主责分册：主文档摘要 + `20-system-context-and-principles.md` + `21-runtime-topology-and-platform-model.md`

### 3. Platform and Data Foundations

主责分册：`21-runtime-topology-and-platform-model.md` + `22-data-consistency-and-routing.md` + `23-interface-contract-catalog.md` + `24-data-contract-catalog.md` + `25-sequence-and-state-machine-catalog.md`

### 4. Protocol Domain Specifications

主责分册：`30-client-identity-and-sync.md`、`31-room-processing-and-room-versions.md`、`32-federation.md`、`33-media.md`、`34-search-directory-and-appservices.md`

### 5. Security and Operational Controls

主责分册：`40-security-and-abuse-resistance.md` + `41-observability-performance-and-cost.md`

### 6. Delivery, Migration, Reliability

主责分册：`42-deployment-migration-and-recovery.md`

### 7. Testing and Compliance

主责分册：`43-testing-and-compliance.md` + `44-verification-and-evidence-register.md`

### 8. Registers and Appendices

主责分册：`spec/open-questions/README.md`、`spec/decisions/README.md`、`92-appendices.md`

## 3. 单体章节到分册映射

| 现有单体章节 | 目标分册 | 后续填充原则 |
| --- | --- | --- |
| 1-5 | `10-governance-and-references.md` | 先固定文档控制、范围、目标、假设、规范引用 |
| 1-5 的权威层与版本治理扩展 | `11-spec-authority-and-version-policy.md` | 定义唯一真相模型、版本锁定、状态模型、权威层级 |
| 全部 Matrix 规范域 | `12-matrix-protocol-compliance-profile.md` | 建立协议覆盖矩阵，防止实现边界失控 |
| 全部 Cloudflare 平台约束 | `13-cloudflare-platform-constraint-register.md` | 建立平台限制、行为、计费约束台账 |
| 全部分册的追溯与变更流程 | `14-traceability-and-change-control.md` | 建立 requirement、constraint、contract、test、evidence 的闭环 |
| 6-7 | `20-system-context-and-principles.md` | 先定义系统上下文、边界、原则 |
| 8-9 | `21-runtime-topology-and-platform-model.md` | 先定义 Cloudflare 拓扑、责任域分配、平台硬约束 |
| 10-12 | `22-data-consistency-and-routing.md` | 先固定数据归属、一致性、路由规则 |
| 8-25 的接口横切层 | `23-interface-contract-catalog.md` | 所有 HTTP、RPC、Queue、Alarm 合同统一收口 |
| 10-24 的数据横切层 | `24-data-contract-catalog.md` | 所有 schema、keyspace、token、cursor 统一收口 |
| 13-24 的流程横切层 | `25-sequence-and-state-machine-catalog.md` | 所有关键时序图与状态机统一收口 |
| 13 + 9.1 + 9.3 + 9.4 | `30-client-identity-and-sync.md` | 身份、设备、E2EE 传输、同步统一成客户端责任域 |
| 14 + 9.2 | `31-room-processing-and-room-versions.md` | 房间核心规则单独收口 |
| 15 + 9.6 | `32-federation.md` | 联邦全部单独收口 |
| 16 + 9.5 | `33-media.md` | 媒体全部单独收口 |
| 17-18 + 9.7 + 9.8 | `34-search-directory-and-appservices.md` | 导出派生能力集中在一起 |
| 19 | `40-security-and-abuse-resistance.md` | 安全与滥用防护单独主责 |
| 20-22 | `41-observability-performance-and-cost.md` | 观测、性能、成本强绑定 |
| 23-24 + 9.9 | `42-deployment-migration-and-recovery.md` | 运维控制面、部署、迁移、修复、恢复一起定义 |
| 25 | `43-testing-and-compliance.md` | 测试与合规独立成册 |
| 全部分册的验证与证据横切层 | `44-verification-and-evidence-register.md` | 发布门禁、证据包、可验证真相统一收口 |
| 26 | `spec/open-questions/README.md` | 未决问题从正文剥离 |
| 27 | `spec/decisions/README.md` | 决策日志从正文剥离 |
| 28 | `92-appendices.md` | 附录独立维护 |

## 4. 阅读顺序

1. 主文档
2. `10-14` 治理控制层
3. `20-25` 架构与契约基础层
4. `30` 协议域分册
5. `40-44` 安全、运营、交付、验证分册
6. `spec/open-questions/`、`spec/decisions/` 与附录

## 5. 回填顺序

1. 先填主文档的文档控制、范围、章节摘要、分册摘要。
2. 再填 `10-14` 治理控制层。
3. 再填 `20-25` 架构、数据、契约、流程基础层。
4. 再按客户端、房间、联邦、媒体、派生能力的顺序填 `30` 系列。
5. 最后填 `40-44`、`spec/open-questions/`、`spec/decisions/` 与附录。

## 6. 主文档后续必须包含的摘要块

* 平台范围摘要
* 架构总览摘要
* Matrix 协议覆盖范围摘要
* Cloudflare 平台约束摘要
* 数据真相面与派生面摘要
* 接口契约与数据契约摘要
* 关键时序与状态机摘要
* 协议域分册索引摘要
* 安全与交付索引摘要
* 测试与验证索引摘要
* 风险、依赖、里程碑摘要

## 7. 主文档完成门槛

* 每个单体章节已经映射到唯一分册；
* 每个 Cloudflare 原语已经找到唯一主责正文；
* 每个 Matrix 责任域已经找到唯一主责正文；
* 每个 requirement、constraint、contract、test、evidence 都有唯一挂载位置；
* 主文档不再承担完整正文职责；
* 开发团队阅读主文档后能准确进入对应分册继续开发。
