# Federation Spec

状态：Outline  
角色：联邦分册  
负责主文档章节：4  
继承的单体章节：15，9.6

## 1. 文档职责

* 定义服务器发现、委派、签名、密钥、交易、恢复与重试。
* 定义联邦入站、出站、缺失事件恢复、媒体联邦边界。
* 定义 `RemoteServerDO` 的职责、队列和重试模型。

明确不包含：

* 不定义房间内部状态解析正文；
* 不定义本地客户端同步正文；
* 不定义通用安全治理正文。

## 2. 依赖与边界

* 上游输入：运行时拓扑分册、数据一致性分册、房间分册、安全分册。
* 下游输出：联邦发现决策树、签名和交易模型、恢复和重试规则、联邦域 `REQ/MX/IF/DATA/FLOW/TEST` 入口。
* 与其他分册接口：与房间分册共享事件接纳入口，与媒体分册共享远端媒体规则。
* 必须引用的官方资料：Matrix server-server API、Cloudflare network ports、Workers outbound connection limits、Durable Objects alarms/docs。

## 3. 待填充章节

### 3.1 Discovery and Delegation

### 3.2 Signing and Key Management

### 3.3 Inbound Transactions

### 3.4 Outbound Transactions

### 3.5 Missing Event Recovery and Backfill

### 3.6 Retry, Backoff, and Dead-Letter Rules

### 3.7 Remote Server Isolation

### 3.8 Federation Media Rules

### 3.9 Operational Guardrails

## 4. 必备附件

* 联邦发现决策树
* 入站/出站交易时序图
* 签名与密钥生命周期表
* 重试状态机
* `RemoteServerDO` 责任矩阵
* 联邦域 `MX-ID` 覆盖清单
* 联邦域接口契约清单
* 联邦域数据契约清单
* 联邦域测试与证据清单

## 5. 完成标准

* 发现与委派规则可直接实现；
* 入站、出站、恢复三条路径闭合；
* 联邦重试与隔离规则明确；
* 联邦域已接入覆盖矩阵、契约目录、流程目录与验证目录；
* 房间域与联邦域的边界没有重叠。
