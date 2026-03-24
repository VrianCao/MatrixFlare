# Data Contract Catalog

状态：Outline  
角色：数据契约总目录  
负责主文档章节：3，4，6  
扩展范围：所有持久化、缓存、游标、令牌与重建输入

## 1. 文档职责

* 统一登记所有数据实体、表、对象键空间、令牌、游标和派生索引契约。
* 规定每类数据的 authority、schema owner、一致性、隐私级别、保留与恢复来源。
* 防止 schema 和 token 规则散落于不同正文中失控。

明确不包含：

* 不替代责任分册解释业务语义；
* 不替代接口契约定义传输形态；
* 不替代迁移 runbook 细节。

## 2. 数据条目模型

每个数据条目至少需要包含：

* `DATA-ID`
* 数据类别
* 逻辑实体 / 表 / 对象 / keyspace / token 类型
* Authority level
* Owning spec
* Owning runtime component
* 物理载体
* 主键 / key pattern
* 核心字段 / schema 引用
* 写入路径
* 读取路径
* 一致性语义
* 保留策略
* 隐私 / 敏感级别
* 恢复来源
* 迁移规则
* Test / Evidence IDs

### 2.1 标准表头

| DATA-ID | Category | Logical Entity / Shape | Authority | Owning Spec | Runtime Owner | Physical Store | Key / Pattern | Schema Ref | Write Paths | Read Paths | Consistency | Retention | Sensitivity | Recovery Source | Migration Rule | TEST/EVID IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DATA-... | table / object / keyspace / token / cursor / manifest | one canonical shape | authoritative / derived / cache | owning spec | runtime component | DO SQLite / D1 / R2 / KV / memory | pk / object key / prefix | schema location | `IF-*` / runtime flow | `IF-*` / query path | linearizable / per-object serial / eventual / strong read-after-write | TTL / forever / archive / tombstone | public / internal / sensitive / secret-derived | replay / rebuild / export / none | additive / migration-needed / rebuild-only | `TEST-*` / `EVID-*` |

### 2.2 颗粒度规则

* 一个 `DATA-ID` 只表示一个规范意义上独立的数据形态。
* 同一实体若在不同存储中以不同 authority 存在，必须拆分为多条。
* token、cursor、checkpoint、manifest 不能作为注释附带，必须单独建条。

## 3. 全局标识与令牌目录

### 3.1 Matrix Identifiers

* User IDs
* Room IDs
* Event IDs
* Device IDs
* Room aliases
* Server names

### 3.2 Internal Identifiers and Tokens

* Sync tokens
* Stream cursors
* Transaction IDs
* Idempotency keys
* Queue job IDs
* Export / replay job IDs

## 4. Authoritative DO Data Contracts

### 4.1 `RoomDO`

* Timeline
* State snapshot
* Membership
* Auth chain helpers
* Event dedupe and indexing helpers

### 4.2 `UserDO`

* Access sessions
* Devices
* Account data
* To-device queues
* Presence / notification streams

### 4.3 `RemoteServerDO`

* Outbound txn queue
* Retry state
* Missing event recovery backlog
* Remote key/cache helpers if applicable

## 5. Derived and Shared Storage Contracts

### 5.1 D1

* Search indexes
* User directory
* Public room directory
* Appservice control-plane data
* Operational metadata

### 5.2 R2

* Local media objects
* Remote media cache objects
* Thumbnails
* Archives / exports / cold history

### 5.3 KV

* Cache-only keyspaces
* Invalidation rules

## 6. Recovery and Rebuild Data Contracts

* Replay input records
* Reindex checkpoints
* Repair manifests
* Export manifests
* Tombstones and deletion markers

## 7. 兼容与迁移规则

* 每个数据契约都必须声明是否允许前向 / 后向兼容。
* 每个 schema 演进都必须声明迁移、回放、重建路径。
* 派生数据必须声明真相来源与可重建性。

## 8. 完成标准

* 所有数据真相面与派生面都已登记；
* token、cursor、idempotency 规则不再散落；
* 恢复与迁移有明确数据入口；
* 开发团队可据此开始 schema 与 keyspace 设计。
