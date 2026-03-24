# Media Spec

状态：Outline  
角色：媒体分册  
负责主文档章节：4  
继承的单体章节：16，9.5

## 1. 文档职责

* 定义本地媒体上传、下载、存储、读取与缓存路径。
* 定义远端媒体抓取、缓存、缩略图、生命周期与清理策略。
* 定义媒体相关的 Cloudflare Worker、R2、缓存与限制适配。

明确不包含：

* 不定义 URL preview 的内容抓取实现正文；
* 不定义搜索索引正文；
* 不定义联邦交易正文。

## 2. 依赖与边界

* 上游输入：运行时拓扑分册、数据一致性分册、安全分册、联邦分册。
* 下游输出：媒体路径时序图、生命周期矩阵、R2 责任边界、媒体域 `REQ/MX/IF/DATA/FLOW/TEST` 入口。
* 与其他分册接口：与联邦分册共享远端拉取边界，与成本分册共享容量与请求计量。
* 必须引用的官方资料：Matrix media repository related spec、R2 pricing/limits/consistency、Workers body size and streaming constraints。

## 3. 待填充章节

### 3.1 Local Upload Path

### 3.2 Local Download Path

### 3.3 Remote Media Cache

### 3.4 Thumbnail Strategy

### 3.5 Media Retention and Lifecycle

### 3.6 Media Config Endpoints

### 3.7 URL Preview Policy

### 3.8 Abuse and Quota Controls

### 3.9 Archive and Export Hooks

## 4. 必备附件

* 上传/下载时序图
* R2 对象布局表
* 媒体生命周期状态机
* 缩略图策略矩阵
* 媒体配额与限流表
* 媒体域 `MX-ID` 覆盖清单
* 媒体域接口契约清单
* 媒体域数据契约清单
* 媒体域测试与证据清单

## 5. 完成标准

* 媒体真相存储与缓存边界明确；
* 上传与下载路径可直接编码；
* 生命周期和配额控制可运维；
* 媒体域已接入覆盖矩阵、契约目录、流程目录与验证目录；
* 与联邦、安全、成本分册的接口完整。
