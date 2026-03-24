# Data, Consistency, and Routing Spec

状态：Outline  
角色：数据基础分册  
负责主文档章节：3  
继承的单体章节：10-12

## 1. 文档职责

* 定义核心实体目录与数据归属。
* 定义真相面、派生面、缓存面的边界。
* 定义各类数据的一致性语义。
* 定义客户端、联邦、媒体、`/.well-known` 的路由模型。
* 定义数据标识、令牌、幂等键与顺序保证的挂载位置。

明确不包含：

* 不展开客户端接口行为；
* 不展开房间算法正文；
* 不展开联邦交互细节。

## 2. 依赖与边界

* 上游输入：运行时拓扑分册、架构原则分册。
* 下游输出：数据放置矩阵、一致性矩阵、路由矩阵、`DATA-ID` 分层归属入口。
* 与其他分册接口：为所有协议分册提供统一数据语义与访问边界。
* 必须引用的官方资料：Durable Objects SQLite、D1 read replication/limits、KV consistency、R2 consistency、Matrix 相关数据语义章节。

## 3. 待填充章节

### 3.1 Core Entity Catalog

### 3.2 Room Graph and State Data

### 3.3 User, Device, Session, and Account Data

### 3.4 Federation Data Model

### 3.5 Media and Archive Data Model

### 3.6 Derived Index and Search Data

### 3.7 Global Consistency Statement

### 3.8 Per-Room, Per-User, Per-Remote-Server Consistency

### 3.9 Cache and Replication Semantics

### 3.10 Request Routing Model

## 4. 必备附件

* 数据放置矩阵
* 一致性级别矩阵
* 路由归属矩阵
* ID / Token / Cursor 规则表
* 真相面与派生面边界图
* `DATA-ID -> Store -> Consistency -> Recovery` 映射表
* 路由到接口契约映射入口

## 5. 完成标准

* 每类数据都有唯一归属；
* 每类一致性语义都能追溯到具体存储与组件；
* 所有入口请求都有明确路由边界；
* 所有 token / cursor / idempotency 规则已挂到 `DATA-ID`；
* 后续协议分册不再自行定义底层一致性真相。
