# Room Processing and Room Versions Spec

状态：Outline  
角色：房间核心分册  
负责主文档章节：4  
继承的单体章节：14，9.2

## 1. 文档职责

* 定义房间核心处理责任。
* 定义事件接纳流水线、授权检查、状态解析与持久化边界。
* 定义房间版本抽象层与版本兼容策略。
* 定义 `RoomDO` 与本地 fanout 的职责边界。

明确不包含：

* 不定义客户端同步正文；
* 不定义联邦外发重试正文；
* 不定义搜索与目录正文。

## 2. 依赖与边界

* 上游输入：运行时拓扑分册、数据一致性分册、客户端分册。
* 下游输出：房间域状态机、事件处理流水线、版本策略接口、房间域 `REQ/MX/IF/DATA/FLOW/TEST` 入口。
* 与其他分册接口：与联邦分册共享事件输入输出边界，与客户端分册共享成员关系和 fanout 语义。
* 必须引用的官方资料：Matrix room versions、event auth/state resolution 相关规范、Cloudflare Durable Objects SQLite docs。

## 3. 待填充章节

### 3.1 RoomDO Responsibilities

### 3.2 Event Admission Pipeline

### 3.3 Event Auth and Authorization Hooks

### 3.4 State Resolution Strategy

### 3.5 Room Version Abstraction Layer

### 3.6 Timeline, State, and Membership Storage Layout

### 3.7 Hot / Warm / Cold Data Boundaries

### 3.8 Local Fanout and User Stream Handoff

### 3.9 Ephemeral Room State

### 3.10 Membership Transitions and Edge Cases

## 4. 必备附件

* 事件接纳时序图
* 房间状态数据流图
* 房间版本适配矩阵
* `RoomDO` 表与索引清单入口
* 本地 fanout 交接规则表
* 房间域 `MX-ID` 覆盖清单
* 房间域接口契约清单
* 房间域数据契约清单
* 房间域测试与证据清单

## 5. 完成标准

* 房间事件真相路径唯一；
* 房间版本适配边界可编码；
* 本地与远端输入的处理规则统一；
* 房间域已接入覆盖矩阵、契约目录、流程目录与验证目录；
* 后续实现团队可直接据此拆解 `RoomDO` 与房间域模块。
