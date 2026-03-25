# Media Spec

状态：Draft-Normative
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

## 2. 媒体权威边界

* 媒体对象本体的权威存储是 R2。引用：`DATA-R2-001`,`DATA-R2-002`。
* 媒体下载所需最小元数据必须能从 R2 object key 或 metadata 恢复，不得把 D1 作为下载前置单点。
* D1 媒体目录只是查询、清理、审计、搜索辅助，不是对象真相。

## 3. 本地上传路径

### 3.1 处理流程

本地上传必须按以下顺序执行：

1. `gateway-worker` 解析 session。
2. 调用 `IF-INT-MEDIA-001 beginMediaUpload(intent)` 完成配额、尺寸、MIME 和并发检查，并创建 `DATA-USER-015` pending upload grant。
3. 生成本地 `mxc://server/media_id`。
4. 将请求体流式写入 `DATA-R2-001`。
5. 写入成功后调用 `IF-INT-MEDIA-002 finalizeMediaUpload(result)`。
6. 投递 `IF-QUE-002` 缩略图和媒体目录更新任务。

### 3.2 尺寸限制

* `m.upload.size` 必须取业务配置与 Cloudflare zone request body 限制中的较小值。引用：`CF-WKR-007`。
* 即使 R2 支持更大 single-part/multipart 上传，本实现的公开 Matrix 上传也不能超过 Worker ingress 限制。引用：`CF-R2-002`。

### 3.3 失败处理

* 写 R2 失败时必须撤销 `DATA-USER-015` pending upload grant。
* finalize 失败时必须把对象标记为 orphan 待清理，不得直接把对象暴露给客户端；对应 pending grant 必须进入终态，避免无限重试。

## 4. 本地下载路径

### 4.1 路由

必须支持：

* 当前 Matrix 客户端媒体下载路径
* 必要的兼容历史媒体路径
* 缩略图路径

### 4.2 读取规则

* `gateway-worker` 解析 MXC 定位本地对象。
* 根据媒体策略决定是否需要鉴权。
* 优先通过 R2 binding 读取并流式返回。
* 若对象不存在但目录残留，返回协议错误并记审计事件。

## 5. 远端媒体缓存

### 5.1 缓存流程

远端媒体 miss 时：

1. 解析远端 MXC。
2. 执行远端发现与连接。
3. 流式抓取远端媒体。
4. 同步写入 `DATA-R2-002`。
5. 写入媒体目录投影。
6. 向客户端返回本次流。

### 5.2 远端抓取护栏

* 必须限制单请求远端抓取并发，预留 R2 与其他 I/O 的连接头寸。引用：`CF-WKR-006`。
* 必须在抓取过程中持续验证字节数，超过上限立即中止。
* 缓存失败不得生成“半存在”目录记录。

## 6. 缩略图策略

### 6.1 生成规则

* 缩略图 key 必须稳定编码源对象和变体参数。引用：`DATA-R2-003`。
* 同一变体的重复生成必须幂等。
* 大对象或高成本变体优先异步生成，小变体可在预算内同步生成。

### 6.2 响应规则

* 若目标缩略图已存在，直接返回。
* 若不存在且策略允许即时生成，则生成并缓存。
* 若生成预算不足，可返回原图或协议错误，具体按客户端兼容策略固定，不得随机变化。

## 7. 生命周期与保留

### 7.1 本地媒体

* 本地媒体默认长期保存，除非达到保留策略或被显式删除。
* 删除必须同时处理 R2 对象、目录投影和缓存 purge。

### 7.2 远端缓存媒体

* 远端缓存媒体允许按 TTL、LRU、总容量上限驱逐。
* 被驱逐的远端缓存对象再次访问时允许重新抓取。

### 7.3 Orphan 与 Pending 清理

* 未 finalize 的 pending upload 必须按 TTL 清理。
* finalize 失败但对象已上传的 orphan object 必须进入后台清理队列。

## 8. URL Preview 策略

* URL preview 当前 profile 为 `Deferred`，默认关闭。
* 若启用，必须通过专用隔离抓取器执行，并满足：
  * 禁止私网与 metadata IP
  * 限制响应大小与跳转层数
  * 限制 MIME 与解析器
  * 结果缓存仅为派生缓存

本分册只定义安全边界；在 dedicated contracts 落地前，不允许对外宣称支持该能力。

## 9. 配额与滥用控制

`UserDO` 必须能针对用户执行以下控制：

* 单对象大小
* 每日上传总字节
* 每日对象数
* 并发 pending upload 数
* 远端媒体下载预算

所有拒绝都必须返回稳定的协议错误，而不是由 R2/Workers 运行时错误直接外泄。

## 10. 归档与导出钩子

* 媒体对象必须支持被导出到恢复包 `DATA-R2-005`。
* 媒体目录必须可由 R2 listing 与导出 manifest 重建。
* 删除历史媒体后若仍有缓存域名，应显式 purge。引用：`CF-R2-004`。

## 11. 媒体域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| media config / create / upload | `IF-CS-050` | `IF-INT-MEDIA-001`,`IF-INT-MEDIA-002` | `DATA-R2-001`,`DATA-D1-004` |
| local download | `IF-CS-051` | none | `DATA-R2-001` |
| remote media cache | federation/media route family | none | `DATA-R2-002`,`DATA-D1-004` |
| thumbnails | `IF-CS-051` | `IF-QUE-002` | `DATA-R2-003` |

## 12. 完成标准

* 媒体真相存储与缓存边界明确；
* 上传与下载路径可直接编码；
* 生命周期和配额控制可运维；
* 媒体域已接入接口、数据、流程目录；
* 与联邦、安全、成本分册的接口完整。
