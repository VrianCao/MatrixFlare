# Search, Directory, and Application Services Spec

状态：Outline  
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

## 2. 依赖与边界

* 上游输入：运行时拓扑分册、数据一致性分册、房间分册、客户端分册。
* 下游输出：派生索引流水线、目录规则、应用服务交付边界、派生能力域 `REQ/MX/IF/DATA/FLOW/TEST` 入口。
* 与其他分册接口：只消费真相面，不重新定义真相语义。
* 必须引用的官方资料：Matrix application service API、Matrix directory/search related client-server sections、Cloudflare D1/Queues docs。

## 3. 待填充章节

### 3.1 Search Scope and Non-Scope

### 3.2 Indexing Pipeline

### 3.3 User Directory

### 3.4 Public Rooms Directory

### 3.5 Reindex and Rebuild Procedures

### 3.6 Application Service Namespace Model

### 3.7 Application Service Transaction Delivery

### 3.8 Application Service Health and Control Plane Storage

### 3.9 Derived Data Ownership Rules

## 4. 必备附件

* 搜索索引流水图
* 目录可见性规则表
* 应用服务命名空间匹配表
* 应用服务投递时序图
* 重建与重放入口表
* 派生能力域 `MX-ID` 覆盖清单
* 派生能力域接口契约清单
* 派生能力域数据契约清单
* 派生能力域测试与证据清单

## 5. 完成标准

* 派生能力和真相面的边界清楚；
* 应用服务交付模型可直接实现；
* 搜索与目录都能追溯到数据来源与重建路径；
* 派生能力域已接入覆盖矩阵、契约目录、流程目录与验证目录；
* 不与其他分册重复定义核心语义。
