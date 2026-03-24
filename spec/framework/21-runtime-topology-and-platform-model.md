# Runtime Topology and Platform Model Spec

状态：Outline  
角色：平台架构分册  
负责主文档章节：2-3  
继承的单体章节：8-9

## 1. 文档职责

* 定义 Worker、Durable Object、D1、KV、R2、Queues、Service Bindings 的使用拓扑。
* 定义 gateway、jobs、ops 三类 Worker 的边界。
* 定义各 Durable Object 类别与责任分工。
* 定义 Cloudflare 平台硬约束、软约束与适配规则。
* 定义 bounded context 到运行时组件的落位关系。

明确不包含：

* 不展开实体级数据模型；
* 不展开协议消息语义；
* 不展开成本测算正文。

## 2. 依赖与边界

* 上游输入：系统上下文与架构原则。
* 下游输出：运行时拓扑图、组件责任表、平台约束表、`CF-ID` 主责映射。
* 与其他分册接口：为 `22-25` 与 `30-44` 分册提供平台落位与主责归属。
* 必须引用的官方资料：Workers limits/pricing、Service Bindings、Durable Objects lifecycle/limits/sqlite、D1 limits、KV consistency、R2 consistency/limits、Queues pricing。

## 3. 待填充章节

### 3.1 Edge Entry Workers

### 3.2 Internal Workers and Service Bindings

### 3.3 Durable Object Classes

### 3.4 Supporting Storage Systems

### 3.5 Async Processing Topology

### 3.6 Cloudflare Limits and Usage Rules

### 3.7 Bounded Context Allocation

### 3.8 Control Plane Placement

### 3.9 Failure Domains and Blast Radius

## 4. 必备附件

* 运行时拓扑图
* Worker/DO/Storage 主责矩阵
* Cloudflare 资源绑定表
* 平台限制适配表
* 责任域落位图
* `CF-ID -> Runtime Component -> Spec` 映射表
* Internal interface family 索引入口

## 5. 完成标准

* 每个 Cloudflare 原语有唯一主责；
* 每个 bounded context 有唯一运行时落位；
* 平台硬限制已经映射到设计约束；
* 所有平台性断言都已回链 `CF-ID`；
* 后续协议分册可直接引用本册组件边界。
