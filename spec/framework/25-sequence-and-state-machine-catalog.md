# Sequence and State Machine Catalog

状态：Outline  
角色：流程与状态机目录  
负责主文档章节：3，4，6，7  
扩展范围：所有关键行为流程

## 1. 文档职责

* 规定哪些关键流程必须有时序图，哪些关键对象必须有状态机。
* 防止复杂行为只用散文描述，导致实现偏差。
* 为测试设计和故障分析提供统一行为模型入口。

## 2. 时序图目录

后续至少需要以下 `FLOW-*`：

* `FLOW-CS-DISCOVERY`
* `FLOW-CS-REGISTER`
* `FLOW-CS-LOGIN`
* `FLOW-CS-REFRESH`
* `FLOW-CS-LOGOUT`
* `FLOW-CS-SYNC-LONGPOLL`
* `FLOW-CS-SEND-EVENT`
* `FLOW-CS-SEND-TO-DEVICE`
* `FLOW-CS-ROOM-MEMBERSHIP`
* `FLOW-CS-MEDIA-UPLOAD`
* `FLOW-CS-MEDIA-DOWNLOAD`
* `FLOW-CS-REMOTE-MEDIA-FETCH`
* `FLOW-ROOM-EVENT-ADMISSION`
* `FLOW-ROOM-LOCAL-FANOUT`
* `FLOW-FED-DISCOVERY`
* `FLOW-FED-INBOUND-TXN`
* `FLOW-FED-OUTBOUND-TXN`
* `FLOW-FED-MISSING-EVENT-RECOVERY`
* `FLOW-FED-JOIN`
* `FLOW-FED-LEAVE`
* `FLOW-AS-TXN-DELIVERY`
* `FLOW-SEARCH-INDEX`
* `FLOW-DEPLOY-VERSION-SKEW`
* `FLOW-REPLAY-REBUILD`
* `FLOW-DISASTER-RECOVERY`

### 2.1 时序图元数据表头

| FLOW-ID | Name | Owning Spec | Participants | Trigger | Success Path | Failure / Retry Path | Key Contracts | Key Data | TEST IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FLOW-*` | concrete flow name | owning child spec | worker / DO / client / remote server | initiating event | summary | retry / timeout / error branch | `IF-*` | `DATA-*` | `TEST-*` |

## 3. 状态机目录

后续至少需要以下 `STATE-*`：

* `STATE-USER-SESSION`
* `STATE-DEVICE-LIFECYCLE`
* `STATE-SYNC-WAITER`
* `STATE-ROOM-EVENT-ADMISSION`
* `STATE-ROOM-MEMBERSHIP`
* `STATE-REMOTE-SERVER-RETRY`
* `STATE-MEDIA-CACHE-OBJECT`
* `STATE-APPSERVICE-TXN`
* `STATE-DEPLOYMENT-ROLLOUT`
* `STATE-REBUILD-JOB`
* `STATE-EXPORT-JOB`

### 3.1 状态机元数据表头

| STATE-ID | Name | Owning Spec | Entity | Persistent State | Triggers | Guards | Side Effects | Recovery Action | TEST IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `STATE-*` | concrete machine name | owning child spec | session / room event / retry queue / media object | yes / no | input events | validation rules | writes / enqueues / emits | timeout / rebuild / replay | `TEST-*` |

## 4. 图示规范

* 每个时序图必须标明参与者、authority handoff、失败分支、重试边界、幂等键。
* 每个状态机必须标明状态、触发器、守卫条件、持久化副作用、超时与恢复动作。
* 图示编号必须稳定，可被接口契约、数据契约、测试计划直接引用。

## 5. 审查规则

* 若某一行为存在并发、重试、恢复、版本偏斜或缓存语义，则必须有图。
* 若某一对象具有生命周期、重试或多阶段处理，则必须有状态机。

## 6. 完成标准

* 所有关键路径均已列入目录；
* 每个复杂行为都知道必须产出哪张图；
* 流程图和状态机可直接服务于实现与测试。
