# Cloudflare Platform Constraint Register

状态：Outline  
角色：平台约束台账分册  
负责主文档章节：1，2，3，5  
扩展范围：全部 Cloudflare 平台依赖

## 1. 文档职责

* 记录所有会影响设计、实现、测试、成本或运营的 Cloudflare 平台事实。
* 把平台限制、平台行为、部署语义、计费维度从正文中抽离，建立唯一权威台账。
* 要求所有引用 Cloudflare 行为的分册都回链到本台账。

明确不包含：

* 不代替各责任分册做设计决策；
* 不代替成本分册做场景估算；
* 不代替外部官方文档本身。

## 2. 台账条目模型

每个约束条目至少需要包含以下字段：

* `CF-ID`
* 产品 / 子产品
* 分类
* 官方来源 URL
* 官方章节 / 摘要
* 适用计划 / 适用范围
* 约束或行为描述
* 设计影响
* Owning spec
* 受影响 runtime component
* 缓解或适配策略
* 验证方式
* 计费影响
* 最近校验日期

### 2.1 标准表头

| CF-ID | Product | Category | Official URL | Source Section | Plan Scope | Constraint / Behavior | Design Impact | Owning Spec | Runtime Owner | Mitigation | Verification | Billing Impact | Last Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CF-... | Workers / DO / D1 / KV / R2 / Queues / Network | limits / lifecycle / billing / consistency / deployment | official URL | exact section | Workers Paid / zone-specific / global | one concrete fact | architecture / performance / cost / reliability effect | `21/22/30-44` | gateway / jobs / ops / DO classes | design response | load / unit / deploy / doc review | request / CPU / storage / op impact | YYYY-MM-DD |

### 2.2 颗粒度规则

* 一个 `CF-ID` 只记录一个具体平台事实。
* 数值限制与行为限制不得混在同一行，除非官方文档也把两者绑定成一个不可拆分事实。
* 任何会影响计费、可靠性、容量或兼容性的事实都必须单独成行。

## 3. Workers 约束分组

### 3.1 Request Lifecycle

* HTTP wall-time model
* CPU time model
* Request cancellation behavior
* Streaming request / response semantics

### 3.2 Runtime Limits

* Memory
* Subrequests
* Simultaneous outgoing connections
* Request body size interaction with zone plan
* Environment variable / secrets behavior

### 3.3 Internal Communication

* Service Bindings
* Worker-to-Worker invocation limits
* Smart Placement applicability

### 3.4 Deployment and Compatibility

* Versions and deployments
* Gradual deployments
* Compatibility date / flags
* Version skew behavior

### 3.5 Observability

* Logs
* OpenTelemetry
* Analytics surfaces

## 4. Durable Objects 约束分组

### 4.1 Concurrency and Routing

* Single-threaded execution
* Object identity and sharding
* Soft throughput characteristics

### 4.2 Lifecycle and Durability

* Startup
* Eviction
* Alarm scheduling
* Code update interactions

### 4.3 SQLite-backed Storage

* Per-object storage cap
* Row / value / statement limits
* Transactional semantics

### 4.4 WebSockets and Hibernation

* Hibernation support
* Disconnect semantics on code update
* Message size / connection behavior

### 4.5 Billing and Limits

* Request billing
* Duration billing
* Storage billing
* CPU configuration

## 5. D1 约束分组

### 5.1 Capacity and Limits

* Per-database size
* Query limits
* Concurrency model

### 5.2 Consistency and Replication

* Single-writer properties
* Read replication lag
* Sessions API and sequential consistency

### 5.3 Billing

* Reads
* Writes
* Storage

## 6. KV 约束分组

### 6.1 Consistency

* Eventual consistency
* Propagation lag

### 6.2 Suitability Boundaries

* Cache-only use
* Unsuitable truth patterns

## 7. R2 约束分组

### 7.1 Consistency and Object Semantics

* Strong consistency
* Object overwrite and read-after-write behavior

### 7.2 Limits

* Object size
* Single-part / multipart boundaries
* Worker ingress interaction

### 7.3 Billing

* Storage
* Class A / B operations
* Egress assumptions

## 8. Queues 约束分组

### 8.1 Delivery Semantics

* Write / read / delete operations
* Retries
* Dead letter queues
* Retention

### 8.2 Cost Semantics

* Operation counting
* Batch implications

## 9. Edge Network and Exposure 约束分组

### 9.1 Public Ports and TLS

* Allowed proxied ports
* Federation exposure implications

### 9.2 Hostname and Well-Known Constraints

* `/.well-known` exposure
* Discovery behavior implications

## 10. 台账使用规则

* 正文中任何 Cloudflare 数值、限制、行为都必须引用 `CF-ID`。
* 若某设计依赖未登记的 Cloudflare 特性，则该设计不能进入 `Draft-Normative`。
* 若 Cloudflare 官方事实变化，必须先更新本台账，再更新受影响正文。

## 11. 完成标准

* Cloudflare 设计相关事实均已挂账；
* 每条事实都能定位到受影响分册与组件；
* 成本、性能、部署、恢复问题都能回链到平台事实；
* 可直接作为 Cloudflare 贴合性审查基线。
