# Spec Authority and Version Policy

状态：Draft-Normative
角色：权威模型分册  
负责主文档章节：1  
扩展的单体章节：1-5 的治理语义

## 1. 文档职责

* 定义哪些文档是规范性真相，哪些文档只是研究输入或历史参考。
* 定义文档状态模型、权威层级、版本锁定与变更准入规则。
* 定义 Matrix 与 Cloudflare 外部来源进入内部规范体系的准入方式。
* 定义“唯一真相”成立所需的硬性条件。

明确不包含：

* 不定义具体协议行为；
* 不定义具体平台参数；
* 不替代分册正文中的架构与实现规则。

## 2. 权威层级模型

### 2.1 外部上游权威

* Matrix 官方规范是协议事实来源。
* Cloudflare 官方文档是平台事实来源。
* 外部来源只提供事实，不直接替代本地开发规范。

### 2.2 内部规范权威

* `spec/framework/00-master-spec-outline.md` 负责定义主入口与章节主责。
* `10-44` 分册负责定义各责任域的规范性内容。
* `90-92` 分册负责决策、问题与附录，不直接定义产品行为。

### 2.2.1 真相层级表

| Level | Artifact Class | Authority |
| --- | --- | --- |
| L0 | Matrix / Cloudflare 官方来源 | 外部事实来源 |
| L1 | `00` 主文档骨架与 `10-14` 治理控制层 | 内部治理真相 |
| L2 | `20-44` 责任分册 | 内部设计与实现真相 |
| L3 | `90-92` 寄存器与附录 | 支持性与审计性真相 |
| L4 | `research/`、`notes/`、遗留单体 Spec | 非规范输入 |

### 2.3 非规范性材料

以下材料只能作为输入，不可被视为当前唯一真相：

* `research/`
* `notes/`
* `matrix-price-calculator.html`
* `spec/matrix-homeserver-cloudflare-spec.md`

## 3. 文档状态模型

### 3.1 允许状态

* `Outline`：仅定义结构，不可作为实现依据。
* `Draft-Normative`：正文已形成，但仍允许结构性调整。
* `Normative`：可作为实现、测试、交付的直接依据。
* `Deprecated`：不再新增内容，只为兼容历史引用。
* `Archived`：仅保留审计价值，不允许再引用为现行真相。

### 3.2 状态晋升条件

从 `Outline` 晋升为 `Draft-Normative` 必须满足：

* 文档职责与边界已闭合；
* 已接入 requirement / contract / test / evidence 链接；
* 已具备必备表格、流程图、状态机与引用。

从 `Draft-Normative` 晋升为 `Normative` 必须满足：

* 无未归属 requirement；
* 无未引用外部事实来源；
* 无未闭合的验证和证据链；
* 无与其他分册冲突的真相定义。

## 4. 版本锁定与来源策略

### 4.1 Matrix 版本锁定

* 当前观察到的 Matrix `latest` 页面在 2026-03-24 显示 `v1.17`。
* 本文档体系后续必须明确区分“实现基线版本”和“上游最新观察版本”。
* `latest` 只能用于变更监测，不能替代固定版本的实现基线。

### 4.2 Cloudflare 来源锁定

* Cloudflare 平台行为必须以官方文档页面为事实来源。
* 平台限制、生命周期、计费、部署和一致性行为在进入正文前，必须先登记到平台约束台账。
* 未进入台账的 Cloudflare 事实，不得在正文中直接作为规范依据。

### 4.3 本地快照策略

* `research/sources/` 是可读缓存，不自动构成现行真相。
* 任一关键事实进入现行规范前，必须在规范正文中重新表述，并指向外部来源和本地台账位置。

### 4.4 来源巡检寄存器

后续必须维护至少以下表头：

| Source Family | Pinned Baseline | Observed Latest | Observation Date | Delta Summary | Action Required | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| Matrix / Cloudflare product line | version or URL set in force | latest observed version / doc revision | YYYY-MM-DD | none / additive / breaking / unclear | no-op / review / decision / migration | role or team |

## 5. 规范语言与引用规则

### 5.1 规范语言

* 所有规范性要求必须使用一致的 requirement level 语言。
* `MUST`、`SHOULD`、`MAY` 等规范词后续在正文中必须保持严格语义。

### 5.2 引用规则

* 每个协议行为都必须指向 Matrix 规范章节或内部权威 requirement。
* 每个平台限制都必须指向 Cloudflare 官方资料或内部台账条目。
* 不允许出现无法追溯来源的数值限制、行为断言、计费假设。

## 6. 标识符方案

### 6.1 Requirement IDs

* `REQ-GOV-*`
* `REQ-ARCH-*`
* `REQ-PLAT-*`
* `REQ-CS-*`
* `REQ-ROOM-*`
* `REQ-FED-*`
* `REQ-MEDIA-*`
* `REQ-AS-*`
* `REQ-SEC-*`
* `REQ-OPS-*`
* `REQ-TEST-*`

### 6.2 Constraint / Contract / Data / Flow / Test IDs

* `CF-*`：Cloudflare 平台约束
* `MX-*`：Matrix 协议覆盖条目
* `IF-*`：接口契约
* `DATA-*`：数据契约
* `FLOW-*`：时序图
* `STATE-*`：状态机
* `TEST-*`：测试项
* `EVID-*`：证据项
* `DEC-*`：决策项
* `OQ-*`：未决问题

## 7. 变更控制

### 7.1 变更触发条件

以下任一变化都必须触发文档更新：

* Matrix 实现支持面变化；
* Cloudflare 平台事实变化；
* 接口变化；
* 数据模型变化；
* 时序或状态机变化；
* 测试或发布门禁变化。

### 7.2 变更包最小内容

每次变更包至少需要同步更新：

* 受影响的责任分册；
* 覆盖矩阵或平台台账；
* 接口或数据契约；
* 测试与证据引用；
* 必要时的决策日志与未决问题寄存器。

### 7.2.1 变更包核对单

* 是否修改了主责分册正文；
* 是否修改了 `MX-ID` 或 `CF-ID`；
* 是否修改了 `IF-ID` 或 `DATA-ID`；
* 是否修改了 `FLOW-ID` 或 `STATE-ID`；
* 是否修改了 `TEST-ID` 与 `EVID-ID`；
* 是否需要新增 `DEC-ID` 或 `OQ-ID`。

### 7.3 冲突解决规则

* 若两个分册对同一行为给出不同结论，以权威主责分册为准。
* 若内部规范与上游官方规范冲突，必须先登记问题与决策，再更新正文，不得静默偏离。

## 8. “唯一真相”成立标准

只有在以下条件同时成立时，本文档系统才可宣称为唯一真相：

* 协议覆盖完整；
* 平台约束完整；
* 接口契约完整；
* 数据契约完整；
* 关键流程与状态机完整；
* 测试与证据闭环完整；
* 所有真相定义均有唯一主责位置。

## 9. 完成标准

* 文档权威层级无歧义；
* 版本锁定与变更控制可执行；
* 任何实现决策都能知道应该改哪份文档；
* 为后续把文档升级到 `Normative` 提供统一门槛。
