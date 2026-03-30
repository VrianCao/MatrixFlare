# Search, Directory, and Application Services Spec

状态：Draft-Normative
角色：派生能力分册  
负责主文档章节：4  
继承的单体章节：17-18，9.7，9.8

## 1. 文档职责

* 定义搜索、用户目录、公共房间目录、重建流程。
* 定义应用服务命名空间、交易投递、健康检查与控制面数据。
* 定义所有派生能力对真相面的依赖方式。

明确不包含：

* 不定义真相数据模型正文；
* 不定义房间事件接纳正文；
* 不定义运维观测正文。

## 2. 派生域总原则

* 搜索、目录、AS 事务索引都属于派生面。
* 派生面失败不得阻塞房间、用户或联邦真相提交。
* 任一派生表都必须声明来源 truth event、幂等键和 rebuild 路径。

## 3. 搜索

### 3.1 Scope

首版搜索定义为：

* 只搜索本服务器有权返回给当前用户的本地可见事件；
* 索引来源是已在 `RoomDO` 成功提交的事件；
* 不对尚未提交、soft-failed、waiting-missing 事件建索引。

### 3.2 Indexing Pipeline

* `RoomDO` 成功提交后投递 `IF-QUE-001 search-index-job`。
* `jobs-worker` 以 `event_id` 作为幂等键写入 `DATA-D1-001`。
* 任一派生索引行若接近 D1 row size ceiling，必须把大 payload 外置到 R2 或拆分多行，只在 D1 保留 locator / searchable projection；不得把全文、审计副本或大 JSON 直接塞进单行。引用：`CF-D1-010`。
* 删除、redaction、visibility 变化必须生成对应的补偿索引更新。

### 3.3 Query Service

* `IF-CS-052` 是 derived read path，不是 indexing path。
* `gateway-worker` 对 `search`、`user_directory/search`、`publicRooms` 与 client `hierarchy` 的请求，必须走统一只读 query dispatch。
* 对具有相同 `filter`、`include_all_networks`、分页参数与 network 范围输入的等价请求，匿名 `GET /publicRooms` 与鉴权态 `POST /publicRooms` 必须共用同一 query family、同一分页/token 规则与同一可见性裁决来源；区别只能体现在 caller identity 与 visibility context，而不能体现在另起一套弱化语义。
* 任何可见性不确定场景都必须回退 truth 或 fail-closed；不得因为索引存在就直接暴露结果。

### 3.4 Rebuild

* 搜索索引必须支持全量重建和按房间重建。
* 重建输入来自 `RoomDO` 真相与 R2 冷历史。
* rebuild / backfill / bulk upsert 必须显式分批，保证每条 SQL statement 不超过 `100 KB`、每 query bound parameters 不超过 `100`，并避免把大作业实现成单次无界批量写。引用：`CF-D1-011`。
* 重建进度由 `DATA-OPS-001` / `DATA-OPS-002` 持久化。

## 4. 用户目录

* 用户目录是 `DATA-D1-002`，来源于本地 `DATA-USER-012` profile truth 与服务器目录策略。
* 被忽略用户、隐私策略和协议可见性必须在查询阶段应用，不得靠索引层硬编码静态结果。
* 用户目录写入失败不得影响用户注册、登录或 profile 更新真相提交。

## 5. 公共房间目录

* 公共房间目录是 `DATA-D1-003`，来源于 `RoomDO` 当前状态与目录可见性配置。
* join rules、history visibility、world readable 与公开目录标记变化都必须触发目录更新。
* 公共目录是最终一致视图；刚发布房间可有短暂滞后。
* 对 client 或 federation query，只要派生面与真相面之间存在可见性不确定，就必须 fail-closed，而不是猜测公开。
* “可见性不确定” 定义为：目录行不存在但房间真相存在、目录行 watermark 落后于当前房间可见性真相、rebuild 进行中、或派生行缺少判断公开性所需字段。

### 5.1 Federation Query 边界

* `IF-FED-006` 里的 hierarchy / directory query 默认读取本节派生面；若派生面进入可见性不确定状态，则必须回退到 `RoomDO` 真相或直接拒绝。
* federation profile query 不属于派生面，必须回到 `DATA-USER-012` profile truth。
* generic federation queries 只有在显式登记后才允许使用本分册数据。

## 6. Application Service 命名空间模型

### 6.1 配置模型

* 每个 appservice 配置必须包含：
  * `appservice_id`
  * homeserver token
  * appservice token
  * sender localpart
  * 用户、房间别名、room namespace 规则
  * exclusive 标志
* token 保存在 secrets；结构化配置保存在 `DATA-D1-005`。

### 6.2 Namespace 裁决

* namespace 匹配必须在事件提交前或标识分配前完成。
* exclusive namespace 被占用时，普通用户和其他 AS 不得绕过。
* namespace 配置变更必须触发缓存失效和必要的目录重建。

## 7. Application Service 事务投递

### 7.1 事务模型

* 每个 appservice 必须拥有独立的顺序事务流。
* `jobs-worker` 负责按 appservice 顺序组装 `IF-AS-002` 事务。
* 事务幂等主键为 `{appservice_id,txn_id}`。

### 7.2 重试语义

* 只有 appservice 返回成功 ack 后，该事务才可标记为完成。
* 失败事务必须重试，但不得阻塞其他 appservice 的投递。
* 毒性事务应进入人工处理状态，而不是永久自旋。

## 8. 健康检查与控制面存储

* appservice 健康检查只能作为运维信号，不改变真相语义。
* 控制面可通过 `ops-worker` 查询每个 appservice 的：
  * 最后成功投递时间
  * backlog 深度
  * 最近错误
  * 当前重试状态
* 在 Phase 03 的基础 schema 中，上述 delivery progress / cursor state 允许与结构化 appservice config 共存于同一 `DATA-D1-005` row（例如 `descriptor.delivery_state`）；真正的按 `txn_id` 有序发射与 ack 推进逻辑仍由后续 Phase 10 落地。

## 9. Derived Data Ownership Rules

* D1 的所有派生表都必须能从真相面重建。
* 对派生表的任何手工修复都必须记录到 `DATA-OPS-003`。
* D1 只保存查询所需的最小投影；超大派生 payload、重建中间产物或导出副本必须外置到 R2，再由 D1 保存 locator / watermark / checksum。引用：`CF-D1-010`,`CF-D1-011`。
* 派生数据被删除时，不得影响公开 API 的真相正确性，只影响可查询性与滞后。

## 10. 派生域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| search | `IF-CS-052` | `IF-INT-WKR-001`,`IF-QUE-001` | `DATA-D1-001` |
| user directory | `IF-CS-052` | `IF-INT-WKR-001` | `DATA-D1-002` |
| public rooms and hierarchy | `IF-CS-052`,`IF-FED-006` | `IF-INT-WKR-001` | `DATA-D1-003` |
| appservice queries | `IF-AS-001` | none | `DATA-D1-005` |
| appservice delivery | `IF-AS-002` | `IF-QUE-003` | `DATA-D1-005` |
| rebuild/reindex | none | `IF-INT-WKR-002`,`IF-QUE-004` | `DATA-OPS-001`,`DATA-OPS-002` |

## 11. 完成标准

* 派生能力和真相面的边界清楚；
* 应用服务交付模型可直接实现；
* 搜索与目录都能追溯到数据来源与重建路径；
* 派生能力域已接入接口、数据、流程目录；
* 不与其他分册重复定义核心语义。
