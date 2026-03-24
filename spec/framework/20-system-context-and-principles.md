# System Context and Principles Spec

状态：Outline  
角色：架构基础分册  
负责主文档章节：2  
继承的单体章节：6-7

## 1. 文档职责

* 定义系统上下文、外部参与者、外部系统与信任边界。
* 定义整体架构原则，包括正确性、存储、并发、成本、可演进性。
* 定义所有后续分册必须遵守的跨域不变量。

明确不包含：

* 不下沉到具体 Cloudflare 资源绑定；
* 不展开具体协议流；
* 不定义接口或表结构正文。

## 2. 依赖与边界

* 上游输入：治理分册、主文档总览。
* 下游输出：系统上下文图、信任边界图、架构原则清单、全局不变量清单。
* 与其他分册接口：为 `21-25`、`30-44` 提供顶层约束。
* 必须引用的官方资料：Matrix 核心协议边界，Cloudflare 平台能力与网络边界文档。

## 3. 待填充章节

### 3.1 External Actors

### 3.2 External Systems

### 3.3 Trust Boundaries

### 3.4 High-Level Context Diagram

### 3.5 Correctness Principles

### 3.6 Storage Principles

### 3.7 Concurrency Principles

### 3.8 Cost Principles

### 3.9 Evolvability Principles

### 3.10 Cross-Cutting Invariants

## 4. 必备附件

* 系统上下文图
* 信任边界图
* 架构原则矩阵
* 全局不变量清单
* 架构原则到 `FLOW/STATE` 的映射入口

## 5. 完成标准

* 系统边界与外部依赖闭合；
* 每项架构原则可被后续分册引用；
* 原则已能约束接口、数据、流程与测试；
* 全局不变量可用于审查各域设计。
