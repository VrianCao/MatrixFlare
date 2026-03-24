# Interface Contract Catalog

状态：Outline  
角色：接口契约总目录  
负责主文档章节：3，4，6  
扩展范围：所有外部与内部交互接口

## 1. 文档职责

* 统一登记所有外部 HTTP 接口与内部 RPC / Queue / Alarm 契约。
* 规定接口的调用方向、鉴权、幂等、重试、一致性和版本规则。
* 防止接口行为散落在不同正文中重复定义。

明确不包含：

* 不展开接口业务语义正文；
* 不存放底层数据 schema；
* 不替代测试或流程序列图。

## 2. 契约条目模型

每个接口条目至少需要包含：

* `IF-ID`
* 接口类型
* 公开性
* 调用方
* 被调方
* 协议 / 传输
* 路由 / 方法 / RPC 名称 / Queue 名称
* 鉴权模型
* 输入契约引用
* 输出契约引用
* 幂等键 / 事务键 / 去重键
* 顺序保证
* 超时 / 重试 / 背压规则
* 错误模型
* Owning spec
* Owning runtime component
* Flow / State IDs
* Test / Evidence IDs

### 2.1 标准表头

| IF-ID | Interface Type | Exposure | Caller | Callee | Transport | Route / RPC / Queue | Auth | Input Contract | Output Contract | Idempotency | Ordering | Timeout / Retry / Backpressure | Error Model | Owning Spec | Runtime Owner | FLOW/STATE IDs | TEST/EVID IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IF-... | HTTP / RPC / Queue / Alarm | public / internal | client / remote server / worker / DO | worker / DO / queue consumer | HTTPS / service binding / DO RPC / queue | concrete callable surface | access token / federation sig / appservice token / internal trust | request schema ref | response schema ref | txn ID / dedupe key | per user / per room / best effort | explicit rule | status code / typed error / retryable flag | owning spec | runtime component | `FLOW-*` / `STATE-*` | `TEST-*` / `EVID-*` |

### 2.2 颗粒度规则

* 一个可独立调用的接口必须对应一个 `IF-ID`。
* 同一路由在不同鉴权模式、版本或一致性合同下，必须拆成多条。
* Queue producer 和 consumer 约定必须共用同一个 `IF-ID`，但需要同时注明两端责任。

## 3. Public HTTP Contracts

### 3.1 Client-Server Contracts

* Discovery and versions
* Authentication and sessions
* Account and profile
* Sync and event retrieval
* Room lifecycle and membership
* Room state and event send
* Devices, to-device, keys
* Media
* Search, notifications, reporting

### 3.2 Federation Contracts

* Discovery and version
* Keys and signing
* Transactions
* Event / state retrieval
* Join / leave / invite / knock
* Queries and directory
* Media

### 3.3 Application Service Contracts

* Transactions
* Ping
* Query endpoints
* Network room directory integration

### 3.4 Well-Known and Auxiliary Contracts

* `/.well-known/matrix/client`
* `/.well-known/matrix/server`
* Support metadata if in scope

### 3.5 Operations and Admin Contracts

* Internal-only admin endpoints
* Export / repair / replay control endpoints
* Health and readiness endpoints

## 4. Internal Runtime Contracts

### 4.1 Worker-to-Worker Service Bindings

* gateway -> jobs
* gateway -> ops
* ops -> jobs

### 4.2 Worker-to-DO Contracts

* gateway -> `UserDO`
* gateway -> `RoomDO`
* gateway -> `RemoteServerDO`
* jobs -> DO classes
* ops -> DO classes

### 4.3 DO-to-DO Contracts

* `RoomDO` -> `UserDO`
* `RoomDO` -> `RemoteServerDO`
* `UserDO` -> `RoomDO` if any

### 4.4 Queue Contracts

* Search indexing jobs
* Media thumbnail jobs
* Archive / export jobs
* Repair / rebuild jobs

### 4.5 Alarm and Scheduled Contracts

* Retry alarms
* Retention alarms
* Rebuild / compaction / cleanup alarms

## 5. 版本与兼容规则

* 公共接口必须定义稳定路径和版本策略。
* 内部接口必须定义跨 Worker / DO 版本偏斜期间的兼容规则。
* 任一接口变更都必须更新调用方、被调方、测试与流程引用。

## 6. 完成标准

* 所有外部与内部接口均已登记；
* 鉴权、幂等、顺序、重试规则都已显式定义；
* 接口不再散落在不同正文中重复定义；
* 开发团队可据此生成 handler、RPC、queue consumer 骨架。
