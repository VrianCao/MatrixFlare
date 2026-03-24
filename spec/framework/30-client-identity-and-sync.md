# Client Identity, E2EE Transport, and Sync Spec

状态：Outline  
角色：客户端责任域分册  
负责主文档章节：4  
继承的单体章节：13，9.1，9.3，9.4

## 1. 文档职责

* 定义用户、设备、会话、账号数据、to-device、presence 的责任边界。
* 定义客户端侧 E2EE 传输相关行为边界。
* 定义 `/sync` 模型、令牌、长轮询、唤醒与增量流。
* 定义客户端域与 `UserDO`、gateway worker 的交互分工。

明确不包含：

* 不定义房间 auth/state resolution 正文；
* 不定义联邦正文；
* 不定义媒体正文。

## 2. 依赖与边界

* 上游输入：运行时拓扑分册、数据一致性分册。
* 下游输出：客户端域状态机、同步流模型、设备和会话边界、客户端域 `REQ/MX/IF/DATA/FLOW/TEST` 入口。
* 与其他分册接口：与房间分册通过事件与成员关系对接，与安全分册共享认证授权约束。
* 必须引用的官方资料：Matrix client-server API、E2EE transport related sections、Cloudflare Workers request lifecycle、Durable Objects websocket/hibernate docs。

## 3. 待填充章节

### 3.1 User and Device Model

### 3.2 Registration, Login, Logout, and Session Rules

### 3.3 Account Data, To-Device, and Presence

### 3.4 E2EE Transport Boundaries

### 3.5 Sync Goals and Token Model

### 3.6 Incremental Stream Model

### 3.7 Worker-Held Long Poll Design

### 3.8 Wakeup Path and Backpressure Rules

### 3.9 Failure, Retry, and Cost Controls

### 3.10 Client Endpoint Grouping and Ownership

## 4. 必备附件

* `UserDO` 责任矩阵
* `/sync` 时序图
* 同步令牌与流游标规则表
* 设备与会话状态机
* 长轮询成本与连接约束表
* 客户端域 `MX-ID` 覆盖清单
* 客户端域接口契约清单
* 客户端域数据契约清单
* 客户端域测试与证据清单

## 5. 完成标准

* 客户端域责任边界闭合；
* `/sync` 模型能直接指导实现；
* E2EE 传输边界与非边界清楚；
* 客户端域已接入覆盖矩阵、契约目录、流程目录与验证目录；
* 与房间域和安全域的接口无重叠。
