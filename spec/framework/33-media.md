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
* 生产媒体出口不得依赖 `r2.dev`；authenticated media 与远端缓存媒体必须通过 Worker/R2 binding，或使用显式 custom domain + purge 策略提供出口。引用：`CF-R2-004`,`CF-R2-007`。

## 3. 本地上传路径

### 3.1 处理流程

本地上传必须按以下顺序执行：

1. `gateway-worker` 解析 session。
2. 调用 `IF-INT-MEDIA-001 beginMediaUpload(intent)` 完成配额、尺寸、MIME 和并发检查，并创建 `DATA-USER-015` pending upload grant。
3. 生成本地 `mxc://server/media_id`。
4. 将请求体流式写入 `DATA-R2-001`。
5. 写入成功后调用 `IF-INT-MEDIA-002 finalizeMediaUpload(result)`。
6. 投递 `IF-QUE-002`，异步执行缩略图生成与媒体目录 upsert。

### 3.2 尺寸限制

* `m.upload.size` 必须取业务配置与 Cloudflare zone request body 限制中的较小值。引用：`CF-WKR-007`。
* 即使 R2 支持更大 single-part/multipart 上传，本实现的公开 Matrix 上传也不能超过 Worker ingress 限制。引用：`CF-R2-002`。

### 3.3 失败处理

* 写 R2 失败时必须撤销 `DATA-USER-015` pending upload grant。
* finalize 失败时必须把对象标记为 orphan 待清理，不得直接把对象暴露给客户端；对应 pending grant 必须进入终态，避免无限重试。
* 对同一 R2 object key 的 finalize/retry 不得并发写；必须退避并带 jitter，避免触发 same-key `429`。引用：`CF-R2-006`。

## 4. 本地下载路径

### 4.1 路由

客户端媒体路由矩阵固定如下：

| Route Family | Upstream Status in `v1.17` | Current Spec Behavior | Notes |
| --- | --- | --- | --- |
| `GET /_matrix/client/v1/media/config` | current | `Required-Core` via `IF-CS-050` | 作为 authenticated media 之后的 current config surface；必须要求 access token。 |
| `GET /_matrix/client/v1/media/download/{serverName}/{mediaId}` | current | `Required-Core` via `IF-CS-051` | 客户端下载当前推荐路径；必须要求 access token。 |
| `GET /_matrix/client/v1/media/download/{serverName}/{mediaId}/{fileName}` | current | `Required-Core` via `IF-CS-051` | 与上条语义相同，但允许稳定 filename；必须要求 access token。 |
| `GET /_matrix/client/v1/media/thumbnail/{serverName}/{mediaId}` | current | `Required-Core` via `IF-CS-051` | 客户端缩略图当前推荐路径；必须要求 access token。 |
| `GET /_matrix/media/*/config` | deprecated compatibility surface | 继续支持并映射到与 `client/v1` 相同 truth | 在当前 profile 下不得弱化为匿名访问。 |
| `GET /_matrix/media/*/download/{serverName}/{mediaId}` | deprecated compatibility surface | 保留 `v1.17` legacy unauthenticated + freeze 语义 | 不得把旧路径强行升级成 authenticated media；对象若在 freeze 之后首次上传/缓存，则必须返回 `404 M_NOT_FOUND`。 |
| `GET /_matrix/media/*/download/{serverName}/{mediaId}/{fileName}` | deprecated compatibility surface | 保留 `v1.17` legacy unauthenticated + freeze 语义 | `fileName` 只影响下游展示/响应头，不改变对象定位；对象若不具备 legacy unauth 访问资格，则必须返回 `404 M_NOT_FOUND`。 |
| `GET /_matrix/media/*/thumbnail/{serverName}/{mediaId}` | deprecated compatibility surface | 保留 `v1.17` legacy unauthenticated + freeze 语义 | 不得出现“新路径有缩略图、旧路径没有”的行为漂移；对象若在 freeze 之后首次上传/缓存，则必须返回 `404 M_NOT_FOUND`。 |
| `POST /_matrix/media/*/create` | current upload-reservation surface | `Required-Core` via `IF-CS-050` | 返回 `mxc://` 预留 ID，供后续 upload-by-ID 使用。 |
| `POST /_matrix/media/*/upload` | current upload surface | `Required-Core` via `IF-CS-050` | 单阶段上传；仍受 Worker ingress body 上限约束。 |
| `PUT /_matrix/media/*/upload/{serverName}/{mediaId}` | current upload-by-ID surface | `Required-Core` via `IF-CS-050` | 必须只接受由 `create` 预留出来的本地 MXC。 |
| `GET /_matrix/client/v1/media/preview_url` + `GET /_matrix/media/*/preview_url` | current + deprecated compatibility surface | `Deferred` via `IF-CS-058` | preview 功能当前统一 stub，不得误宣称支持。 |

### 4.2 读取规则

* `gateway-worker` 解析 MXC 定位本地对象。
* `/_matrix/client/v1/media/{config,download,thumbnail}` current authenticated media 路由必须要求 access token。
* deprecated `/_matrix/media/*/config` compatibility 路由仍要求 access token。
* deprecated `/_matrix/media/*/download` 与 `/_matrix/media/*/thumbnail` compatibility 路由不得要求 access token；它们必须改按 immutable `legacy_unauth_media_freeze_at` 与对象 metadata 中的 `legacy_unauth_access_flag` 执行 legacy unauthenticated + freeze 裁决。
* 优先通过 R2 binding 读取并流式返回。
* `/_matrix/client/v1/media/*` current surface 与 `/_matrix/media/*` compatibility surface 必须共用同一对象真相、参数解释、缓存命中与审计逻辑；但 deprecated `download` / `thumbnail` compatibility 路由的 legacy unauthenticated + freeze 裁决不得被“统一 auth gate”覆盖。
* 若对象不存在但目录残留，返回协议错误并记审计事件。

### 4.3 Query 参数与下载语义

* client download 路由与其 compatibility 路由必须至少固定 `allow_redirect`、`allow_remote`、`timeout_ms` 三个 query 参数语义：
  * `allow_redirect = true` 时，服务端可返回 `307/308`；未显式设为 `true` 时，必须直接返回媒体内容本体，而不是重定向。
  * `allow_remote` 缺省为 `true`；当其为 `false` 时，服务端不得主动抓取远端媒体。
  * `timeout_ms` 缺省为 `20000`，表示客户端愿意等待开始接收数据的最长时间；服务端可以更早返回，也应施加实现侧最大值。
* client thumbnail 路由与其 compatibility 路由必须固定以下参数语义：
  * `width`、`height` 为 required；
  * `method` 只允许 `crop` 或 `scale`；
  * `animated` 缺省时服务端 SHOULD NOT 返回 animated thumbnail；`animated = false` 时 MUST NOT 返回 animated thumbnail；`animated = true` 且源对象不可动画化时，行为必须退化为 `false`；
  * `allow_remote` 与 `timeout_ms` 的语义与 download 路由一致。
* current `client/v1` 路由与 deprecated compatibility 路由的 query 参数解释必须严格一致；不得出现“旧路由忽略 `allow_remote` / `timeout_ms` / `animated`，新路由才生效”的实现分叉。

## 5. 远端媒体缓存

### 5.1 缓存流程

远端媒体 miss 时：

1. 解析远端 MXC。
2. 若请求来自 deprecated unauthenticated `/_matrix/media/*/download` 或 `thumbnail` 路由，则必须先检查目标缓存对象是否已存在且 `legacy_unauth_access_flag = true`；若不满足，直接返回 `404 M_NOT_FOUND`，不得触发新的远端抓取。
3. 执行远端发现与连接。
4. 流式抓取远端媒体。
5. 同步写入 `DATA-R2-002`，并把该缓存对象的 `legacy_unauth_access_flag` 固定为“是否在 freeze 前首次填充缓存”。
6. 投递 `IF-QUE-002`，异步写入媒体目录与需要的缩略图任务。
7. 向客户端返回本次流。

### 5.2 远端抓取护栏

* 必须限制单请求远端抓取并发，预留 R2 与其他 I/O 的连接头寸。引用：`CF-WKR-006`。
* 必须在抓取过程中持续验证字节数，超过上限立即中止。
* 缓存失败不得生成“半存在”目录记录。

## 6. 缩略图策略

### 6.1 生成规则

* 缩略图 key 必须稳定编码源对象和变体参数。引用：`DATA-R2-003`。
* 缩略图变体参数至少必须包含 `width`、`height`、`method` 与 `animated`；不得让 animated 与 non-animated 结果共用同一对象 key。引用：`DATA-R2-003`。
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
| media config / create / upload | `IF-CS-050` | `IF-INT-MEDIA-001`,`IF-INT-MEDIA-002`,`IF-QUE-002` | `DATA-USER-015`,`DATA-R2-001` |
| local media serve | `IF-CS-051`,`IF-FED-005` | none | `DATA-R2-001`,`DATA-R2-003` |
| remote media cache | `IF-CS-051` | `IF-QUE-002` | `DATA-R2-002`,`DATA-D1-004` |
| thumbnails and media catalog derivation | none | `IF-QUE-002` | `DATA-R2-003`,`DATA-D1-004` |

## 12. 完成标准

* 媒体真相存储与缓存边界明确；
* 上传与下载路径可直接编码；
* 生命周期和配额控制可运维；
* 媒体域已接入接口、数据、流程目录；
* 与联邦、安全、成本分册的接口完整。
