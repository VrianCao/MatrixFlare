# Matrix Homeserver Cloudflare Spec Framework

状态：Draft-Normative
范围：企业级开发 Spec 框架与主文档入口
适用对象：架构、协议、平台、基础设施、测试、交付团队

## 1. 框架目标

本目录定义 Matrix homeserver on Cloudflare 的企业级开发规范框架与责任分册入口。

当前状态已经不是“只规划骨架”，而是：

1. 主文档与分册边界已固定；
2. 多数责任分册已进入 `Draft-Normative`，可直接作为实现输入；
3. 尚未闭合的能力面必须显式登记到 `spec/open-questions/` 或 `Deferred` / `Required-Conditional` 寄存器中。

当前仍不做以下事情：

* 不把历史研究稿继续当作现行真相；
* 不允许未挂 `REQ/MX/CF/IF/DATA/FLOW/TEST/EVID` 的新行为混入正文；
* 不允许主入口再演化成第二份并列单体 Spec。

## 2. 组织原则

* 主文档只负责总览、全局约束、分册索引、阅读顺序、回填顺序。
* 分册只负责单一责任域，不混合产品范围、协议语义、平台约束、交付治理。
* 事实来源后续只允许使用 Matrix 官方 Spec 与 Cloudflare 官方文档。
* Cloudflare 平台限制必须在对应分册显式落地，不能隐藏在抽象表述中。
* 决策记录、未决问题、附录与追溯矩阵独立维护，不混入正文段落。
* 后续填充必须以主文档为入口，再向下分解到各责任分册。

## 3. 文档包

* [00-master-spec-outline.md](./00-master-spec-outline.md)：主 Spec 骨架，定义顶层章节树与分册映射。
* [_template.md](./_template.md)：分册统一模板。
* [10-governance-and-references.md](./10-governance-and-references.md)：文档控制、范围、目标、假设、规范引用。
* [11-spec-authority-and-version-policy.md](./11-spec-authority-and-version-policy.md)：唯一真相模型、版本锁定、规范状态与权威层级。
* [12-matrix-protocol-compliance-profile.md](./12-matrix-protocol-compliance-profile.md)：Matrix 协议覆盖矩阵与实现支持面。
* [13-cloudflare-platform-constraint-register.md](./13-cloudflare-platform-constraint-register.md)：Cloudflare 平台限制、行为与计费约束台账。
* [14-traceability-and-change-control.md](./14-traceability-and-change-control.md)：需求、约束、契约、测试、证据的追溯与变更控制。
* [15-source-observation-register.md](./15-source-observation-register.md)：Matrix 与 Cloudflare 上游来源观察、漂移结论与动作寄存器。
* [20-system-context-and-principles.md](./20-system-context-and-principles.md)：系统上下文、信任边界、架构原则。
* [21-runtime-topology-and-platform-model.md](./21-runtime-topology-and-platform-model.md)：Workers、Durable Objects、D1、KV、R2、Queues 拓扑与约束。
* [22-data-consistency-and-routing.md](./22-data-consistency-and-routing.md)：数据模型、数据放置、一致性、路由边界。
* [23-interface-contract-catalog.md](./23-interface-contract-catalog.md)：外部 HTTP、内部 RPC、队列、告警等接口契约总目录。
* [24-data-contract-catalog.md](./24-data-contract-catalog.md)：DO、D1、R2、KV、令牌、游标等数据契约总目录。
* [25-sequence-and-state-machine-catalog.md](./25-sequence-and-state-machine-catalog.md)：关键时序图与状态机目录。
* [30-client-identity-and-sync.md](./30-client-identity-and-sync.md)：身份、设备、会话、E2EE 传输、`/sync`。
* [31-room-processing-and-room-versions.md](./31-room-processing-and-room-versions.md)：房间处理、状态解析、房间版本策略。
* [32-federation.md](./32-federation.md)：联邦发现、签名、交易、恢复、重试。
* [33-media.md](./33-media.md)：媒体上传下载、缓存、缩略图、生命周期。
* [34-search-directory-and-appservices.md](./34-search-directory-and-appservices.md)：搜索、目录、应用服务。
* [40-security-and-abuse-resistance.md](./40-security-and-abuse-resistance.md)：认证授权、密钥、隔离、滥用防护。
* [41-observability-performance-and-cost.md](./41-observability-performance-and-cost.md)：观测、性能、容量、成本。
* [42-deployment-migration-and-recovery.md](./42-deployment-migration-and-recovery.md)：部署、版本、迁移、回放、恢复。
* [43-testing-and-compliance.md](./43-testing-and-compliance.md)：测试、合规、验证门禁。
* [44-verification-and-evidence-register.md](./44-verification-and-evidence-register.md)：测试证据、发布门禁、需求到证据闭环。
* [`../open-questions/README.md`](../open-questions/README.md)：未决问题权威入口。
* [`../decisions/README.md`](../decisions/README.md)：架构与实现决策权威入口。
* [90-open-questions.md](./90-open-questions.md)：兼容索引页，指向权威未决问题目录。
* [91-decision-log.md](./91-decision-log.md)：兼容索引页，指向权威决策目录。
* [92-appendices.md](./92-appendices.md)：术语、附录、补充材料入口。

## 4. 演进顺序

1. 先填 [00-master-spec-outline.md](./00-master-spec-outline.md) 的主文档总览与章节摘要。
2. 再填 `10-15` 治理控制层，先把范围、权威模型、协议覆盖、平台约束、追溯规则与来源观察寄存器钉死。
3. 再填 `20-25` 架构基础层，先把平台、数据、契约、流程骨架钉死。
4. 之后按协议责任域回填 `30` 系列分册。
5. 再填 `40-44` 安全、运营、交付、验证分册。
6. 最后持续维护 `spec/open-questions/`、`spec/decisions/` 与附录。

## 5. 历史输入

后续填充本框架时，优先使用以下本地材料作为整理输入，但不得把它们直接当作最终规范正文：

* `spec/matrix-homeserver-cloudflare-spec.md`
* `research/notes/initial-research.md`
* `research/notes/source-index.md`
* `notes/matrix-cloudflare-feasibility.md`

## 6. 唯一真相判定条件

只有在以下条件同时满足时，这套文档才能被视为唯一真相：

* Matrix 协议实现边界已经在 [12-matrix-protocol-compliance-profile.md](./12-matrix-protocol-compliance-profile.md) 完整登记。
* Cloudflare 平台限制、平台行为与计费边界已经在 [13-cloudflare-platform-constraint-register.md](./13-cloudflare-platform-constraint-register.md) 完整登记。
* 每个外部或内部接口都已经在 [23-interface-contract-catalog.md](./23-interface-contract-catalog.md) 定义契约。
* 每个持久化或令牌型数据都已经在 [24-data-contract-catalog.md](./24-data-contract-catalog.md) 定义契约。
* 每条关键流程都已经在 [25-sequence-and-state-machine-catalog.md](./25-sequence-and-state-machine-catalog.md) 建立时序图或状态机。
* 每个 requirement、constraint、contract 都能在 [14-traceability-and-change-control.md](./14-traceability-and-change-control.md) 规则下追到测试和证据。
* 每个发布门禁都能在 [43-testing-and-compliance.md](./43-testing-and-compliance.md) 与 [44-verification-and-evidence-register.md](./44-verification-and-evidence-register.md) 找到验证闭环。

## 7. 编写约束

* 每份分册必须显式写出“职责”“边界”“依赖”“待填章节”“必备附件”“完成标准”。
* 每个 Cloudflare 原语的使用位置必须在某一分册内有唯一主责，不允许多份正文并列定义真相。
* 每个 Matrix 协议域必须能追溯到唯一分册，不允许主文档与分册重复写完整正文。
* 主文档允许摘要，不允许演变成另一份完整单体 Spec。
* 任何平台限制、协议要求、接口行为、数据语义、状态机转换，如果尚未落在对应权威文档中，就不允许视为已定义。
* `notes/`、`research/`、遗留单体 Spec 都只能作为输入材料，不能直接替代当前文档系统的权威位置。
