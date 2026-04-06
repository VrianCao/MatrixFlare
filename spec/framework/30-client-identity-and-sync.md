# Client Identity, E2EE Transport, and Sync Spec

状态：Draft-Normative
角色：客户端责任域分册  
负责主文档章节：4  
继承的单体章节：13，9.1，9.3，9.4

## 1. 文档职责

* 定义用户、设备、会话、账号数据、to-device、presence 的责任边界。
* 定义客户端侧 E2EE 传输相关行为边界。
* 定义 `/sync` 模型、令牌、长轮询、唤醒与增量流。
* 定义客户端域与 `UserDO`、`gateway-worker` 的交互分工。

明确不包含：

* 不定义房间 auth/state resolution 正文；
* 不定义联邦正文；
* 不定义媒体正文。

## 2. 责任边界

### 2.1 `UserDO` 是客户端域权威

`UserDO(user_id)` 必须拥有以下真相：

* user principal / auth profile
* access token / refresh token 生命周期
* device 清单与设备元数据
* device keys、cross-signing、one-time/fallback keys
* profile document
* global / room account data
* stored filter definitions
* push rules overrides / enablement
* to-device 队列
* presence 当前值
* `user_stream` 及其 `user_stream_pos`

### 2.2 `gateway-worker` 是客户端域接入层

`gateway-worker` 必须负责：

* 公开 Client-Server API 路由
* access token 解析与 `UserDO` 定位
* `/sync` 长轮询持有
* 响应聚合与流式输出
* 将房间写路径转交 `RoomDO`
* 浏览器 Matrix Client-Server 流量的 CORS / preflight 终结

`gateway-worker` 不得拥有任何客户端真相。

对浏览器可达的 Matrix 公开入口，`gateway-worker` 还必须满足：

* `/.well-known/matrix/client`、`/_matrix/client/versions` 与 `/_matrix/client/*` 在收到合法 browser `Origin` 时，实际响应必须返回一致的 CORS allow-origin 语义，避免 Web client 因跨域读取被阻断。
* 对这些同一路由族所需的 `OPTIONS` preflight，`gateway-worker` 必须直接返回 `2xx/204` CORS 响应；不得把预检请求落到 route-specific `M_UNRECOGNIZED` 或 plain-text `404`。
* 该要求只适用于公开 Matrix client ingress；不得借此把受保护的 `/_ops` 或其它非 Matrix 管理面扩大成 browser-readable public surface。

## 3. 用户、设备与会话模型

### 3.1 用户模型

* 用户身份以 Matrix `user_id` 为唯一主键。
* 本地账户主记录是 `DATA-USER-017`；它至少承载 password credential、`user_type`、deactivated 状态、`erase_requested` 标记与单调递增的 `auth_version`。
* 所有认证成功最终都必须归一到 “生成或恢复一个 `UserDO` 作用域内的 session”。
* 用户注销、停用、会话吊销都必须从 `UserDO` 真相出发，而不是依赖缓存层。

### 3.2 设备模型

* 设备是 `user_id` 下的稳定命名实体，由 `device_id` 标识。
* 设备是以下数据的关联点：
  * access session
  * refresh session
  * device keys
  * one-time / fallback keys
  * to-device 投递目标
* 设备删除必须原子地使其 access session 和设备 key 失效。

### 3.3 会话模型

规范性 session 状态机引用：`STATE-USER-SESSION`。

会话实现必须满足：

* access token 仅以 hash 形式存储。引用：`DATA-ID-003`。
* refresh token 仅以 hash 形式存储。引用：`DATA-ID-004`。
* session 有效性判定必须同时受 `DATA-USER-017.deactivated_at_or_null` 与 `DATA-USER-017.auth_version` 约束；账户已停用或 session 落后于当前 `auth_version` 时，必须直接失效。
* `logout` 撤销当前 session；`logout/all` 撤销用户全部活动 session。
* 推荐在 `UserDO` 内维护 `session_epoch`；`logout/all` 通过 epoch 跳变实现 O(1) 失效判定，然后异步清扫旧 session 记录。

### 3.4 鉴权基线

* 所有 access token 校验必须走 `IF-INT-USER-001`。
* session 校验结果必须至少返回：
  * `user_id`
  * `device_id`
  * `session_id`
  * `expires_at`
  * `is_guest`
  * `auth_version`
  * `session_epoch`
* 任何鉴权失败都不得进入 `RoomDO` 或后续业务路径。

## 4. 注册、登录、密码变更、停用、刷新与注销规则

### 4.1 共享 UIA Challenge 模型

* 当前 profile 下所有启用的 UIA 路由族至少包括 `POST /register`、`POST /account/password`、`POST /account/deactivate`、`DELETE /devices/{deviceId}` 与 `POST /delete_devices`。
* `gateway-worker` 必须为 UIA 发行 `DATA-ID-006` 短时 challenge token，而不是依赖本地内存态；token 必须签名、opaque、route-bound，并绑定：
  * 目标 route family 与 HTTP method
  * `issued_at` / `expires_at`
  * `auth_subject_hint`
  * `completed_stages`
  * `nonce`
  * `root_key_version`
* 同一个 UIA challenge token 不得跨 route family、跨主体或跨根密钥版本重放。
* `DATA-ID-006` 的签发与签名验证只能由 `gateway-worker` 执行；`UserDO` 只可接收已归一化的 challenge 裁决结果，不得自行解析 raw token 或持有对应签名 secret。
* UIA active keyring 必须显式支持 rollout overlap：至少保留当前 verify key 与上一个 verify key，且旧 `root_key_version` 只能在“所有旧 deployment 已退出 + 最大 token TTL 已过”之后移除。
* 若 UIA keyring 存放于 Worker secrets，其单 secret 序列化体必须满足 Cloudflare `5 KB` 上限；若超过该上限，必须先切换到 Secrets Store 或分片 versioned secrets，再允许进入发布门禁。
* challenge 完成后真正落盘的写路径仍必须回到对应 authority；对客户端域而言，最终提交一律由 `UserDO` 裁决。

### 4.2 注册

* `GET /_matrix/client/r0/register`、`GET /_matrix/client/v1/register` 与 `GET /_matrix/client/v3/register` 都必须存在，作为 registration discovery compatibility surface 返回当前真实支持的 registration UIA stages；当 homeserver 当前不允许 registration 时，必须返回 `403 M_FORBIDDEN`。
* `GET /_matrix/client/*/register` 只能宣告当前真实实现的 registration UIA stage；当前基线只允许宣告 `m.login.dummy`。registration token policy 若存在，必须继续由 `POST /register` 的 policy enforcement 与 `GET /register/m.login.registration_token/validity` 真值承担，不得被误宣告成已实现的 UIA stage。
* `GET /_matrix/client/*/register` 不得被 shared edge cache、browser cache 或其它跨请求缓存当作可陈旧结果复用；响应必须使用 `no-store` 语义。
* `POST /_matrix/client/*/register` 在缺少或未完成 UIA 时，必须优先返回 route-bound `401` challenge，而不是先因为缺少 `username`、`password` 或 `registration_token` 之类的请求字段返回 `400/403`；这条顺序约束是为了兼容先用空请求探测 registration options 的客户端。
* `GET /_matrix/client/*/register/available` 必须存在，并只根据当前 registration policy、MXID grammar 与本地账户真值裁决可用性；不得读取可陈旧目录索引替代 `DATA-USER-017`。
* `GET /_matrix/client/*/register/available` 不得被 shared edge cache、browser cache 或其它跨请求缓存当作可陈旧结果复用；响应必须使用 `no-store` 语义，最多只允许同一请求链路内的局部 memoization。
* `GET /_matrix/client/v1/register/m.login.registration_token/validity` 必须存在；当 homeserver 当前不允许 registration 时，必须返回 `403 M_FORBIDDEN`；否则必须返回 `200 { valid: boolean }`，并对未知或当前无效 token 返回 `valid = false`。
* `POST /_matrix/client/r0/register`、`POST /_matrix/client/v1/register` 与 `POST /_matrix/client/v3/register` 都必须收敛到同一 registration/UIA 真值，不得因 alias 不同而漂移 challenge、错误模型或成功写入语义。
* 所有注册流程都必须收敛到 `UserDO` 创建用户主记录、初始 device 和初始 session。
* 成功注册必须原子写入 `DATA-USER-017`、初始 `DATA-USER-002` device 与初始 `DATA-USER-001` session。
* 若注册需要 UIA、registration token 或其他前置校验，`gateway-worker` 只负责协议编排，最终提交仍由 `UserDO` 原子完成。
* `/_matrix/client/*/register/{email,msisdn}/requestToken` 属于 `MX-CS-025`；当前默认关闭时必须落到 `IF-CS-007` stub，而不是局部创建 verification session。
* 同一注册请求的重试不得造成重复用户创建。

### 4.3 登录

* `GET /_matrix/client/r0/login`、`GET /_matrix/client/v1/login` 与 `GET /_matrix/client/v3/login` 都必须始终可用，并由 `IF-CS-005` 输出当前真实支持的 login flow 集合。
* `L1-L3` 基线下，`GET /login` 必须宣告 `m.login.password`；只有在 `MX-CS-003` 真正启用且 dedicated contracts 完整落地后，才允许宣告 `m.login.sso`。
* `m.login.token` 只有在服务器同时支持对应的 login-token consumption 语义时才允许出现在 `GET /login`；当前默认关闭 `MX-CS-003` 时不得宣告。
* `POST /_matrix/client/r0/login`、`POST /_matrix/client/v1/login` 与 `POST /_matrix/client/v3/login` 都必须收敛到同一 password-login 真值，不得因 alias 不同而漂移成功条件、错误模型或 session/device 副作用。
* `POST /login` 若收到未在 `GET /login` 中宣告的 login type，必须按 Matrix `v1.17` core login 规则返回 `400` + `M_UNKNOWN`，不得把“关闭的 flow”做成节点间漂移的任意错误。
* `POST /login` 对本地 password flow 的认证真值必须来自 `DATA-USER-017.password_hash_or_null` 与 `password_login_enabled`；不得绕过 `UserDO` 在 Worker 内直接验密。
* 若账户已在 `DATA-USER-017` 中标记停用，登录必须返回 `M_USER_DEACTIVATED`。
* 登录成功必须创建或恢复一个 device 关联的活动 session。
* `login` 响应中的 access token 和 refresh token 必须绑定到同一 `session_id`。
* 登录失败不得产生任何残留 session、device 或用户流副作用。

### 4.4 密码变更

* `GET /_matrix/client/*/capabilities` 必须把 `m.change_password.enabled` 与 `IF-CS-006` 的真实可达性保持一致；`L1-L3` 基线下必须返回 `true`。
* `POST /_matrix/client/*/account/password` 必须使用 route-bound UIA challenge，不得把某个 route 上通过的 UIA 直接复用于其它高风险写路径。
* 当请求携带有效 access token 时，UIA 的主体必须与该 session 绑定的 `user_id` 完全一致。
* 当请求不携带 access token 时，当前 profile 仍允许通过本地 password UIA 完成密码变更；但 `/_matrix/client/*/account/password/{email,msisdn}/requestToken` 默认关闭，必须继续落到 `IF-CS-007` stub。
* 密码变更成功时，`UserDO` 必须在同一原子提交中：
  * 更新 `DATA-USER-017.password_hash_or_null`
  * 单调递增 `DATA-USER-017.auth_version`
  * 按 `logout_devices` 参数裁决其他 session / device 的后续有效性
* `logout_devices` 缺省值是 `true`；当其为 `true` 时，除请求所用的当前 session 外，其它 session 必须立即失效；当其为 `false` 时，服务端可以保留其它 session，但不得让旧密码继续通过新的 UIA / login 校验。
* 任一失败都不得出现“密码已更新但 `auth_version` 未推进”或“部分 session 仍按旧密码语义工作”的中间态。

### 4.5 账户停用

* `POST /_matrix/client/*/account/deactivate` 必须使用 route-bound UIA challenge。
* 停用成功时，`UserDO` 必须原子完成以下动作：
  * 写入 `DATA-USER-017.deactivated_at_or_null`
  * 清空或禁用本地 password credential，使后续 login / UIA 返回 `M_USER_DEACTIVATED`
  * 单调递增 `DATA-USER-017.auth_version`
  * 撤销全部现有 access/refresh session
* 返回体中的 `id_server_unbind_result` 必须按 Matrix `v1.17` 固定为 `success` 或 `no-support`；在当前默认 profile 没有任何已绑定 3PID 时，该字段必须返回 `success`。
* 当 `erase = true` 时，系统必须尽最大可能清理本地非事件数据；至少包括 `DATA-USER-006`、`DATA-USER-007`、`DATA-USER-009`、`DATA-USER-012`、`DATA-USER-013`，并设置 `erase_requested_flag` 供后续房间可见性路径对未来加入者只暴露 redacted copies。
* `erase = true` 不得伪造联邦 redaction，也不得把“对未来本地可见性变红”误实现成修改历史事件真相。
* 停用成功后，任何旧 session、refresh token 或 password UIA 都不得继续通过。

### 4.6 刷新

* `refresh` 必须通过 `IF-CS-012` 与 `IF-INT-USER-001`/`IF-INT-USER-002` 相同的 `UserDO` 权威路径完成。
* refresh 成功后，旧 refresh token 必须失效，access token 应同时轮换。
* refresh token 重放必须返回明确失败，而不是返回新的可用 token。

### 4.7 注销

* `POST /_matrix/client/*/logout` 只撤销当前 session。
* `POST /_matrix/client/*/logout/all` 撤销全部 session，并强制后续 access token 失效。
* 注销不删除 device；设备删除是单独操作。

### 4.8 `whoami`

* `GET /_matrix/client/*/account/whoami` 必须返回当前 access token 绑定的 `user_id`，并在存在 device 绑定时返回与该 session 真值一致的 `device_id`。
* `whoami` 必须与 `IF-INT-USER-001` / `STATE-USER-SESSION` 使用同一 session 权威路径，不得在 `gateway-worker` 本地缓存或推断主体真值。
* 当 access token 已失效、被 `logout`/`logout/all` 撤销，或其所属账户已停用时，`whoami` 必须返回与同一 session 解析路径一致的鉴权失败，而不是继续泄露旧主体。

## 5. 能力声明、Device Management、Profile、账号数据、Push Rules、To-Device 与 Presence

### 5.1 Capabilities and Filters

* `GET /_matrix/client/*/capabilities` 的结果来自部署时配置与运行时策略，但其返回值必须与真实可写权限一致。
* `m.profile_fields` 必须返回规范要求的 `enabled`，并按实际策略返回可选的 `allowed` / `disallowed` 列表。
* 若 `m.profile_fields` 直接或间接禁止修改 `displayname` 或 `avatar_url`，则已废弃的 `m.set_displayname` / `m.set_avatar_url` 也必须同步返回 `enabled: false`。
* `m.change_password.enabled` 必须只在 `IF-CS-006` 真实可用时返回 `true`；当前 `L1-L3` 基线必须显式返回 `true`。
* 当 `MX-CS-005` 默认关闭时，`GET /_matrix/client/*/capabilities` 必须显式返回 `m.3pid_changes.enabled = false`，避免客户端按“未列出即默认可改”误判。
* 当 `MX-CS-003` 默认关闭时，`GET /_matrix/client/*/capabilities` 必须显式返回 `m.get_login_token.enabled = false`。
* `m.profile_fields`、`m.set_avatar_url`、`m.set_displayname`、room versions 等 capability 不得“宣称支持但写路径拒绝”。
* stored filters 的权威表是 `DATA-USER-014`。
* filter 创建时必须按 [22-data-consistency-and-routing.md](/root/Matrix/spec/framework/22-data-consistency-and-routing.md) 的非事件 JSON canonicalization 规则处理 JSON，再生成稳定 hash 和 `filter_id`；`filter_id` 不得以 `{` 开头。
* `GET /_matrix/client/*/sync` 的 `filter` 查询参数必须按首字符解释：若首字符是 `{`，则视为 inline JSON filter string；否则视为此前创建的 stored `filter_id`。
* `/sync` 对 stored filter 和 inline filter 的解释都必须确定；相同 `{since,filter}` 不得因部署节点不同而产生语义分叉。
* Matrix `v1.17` filter 中与 `/sync` 响应结构直接相关的布尔开关必须明确实现：`include_leave`、`lazy_load_members`、`include_redundant_members`、`unread_thread_notifications`。未显式给出的布尔值按规范默认 `false` 处理。
* `include_leave = false` 时，本实现固定选择整体省略 `rooms.leave` bucket，而不是返回空 bucket；即使本地真相仍保留 left / banned-but-not-forgotten 房间，只有在 `include_leave = true` 时，这些房间才允许出现在 `/sync`。
* `include_redundant_members` 只有在启用 `lazy_load_members` 时才有意义；否则必须按 `false` 处理，不得制造与未启用 lazy-load 不同的成员事件输出。
* capability truth 与 route truth 必须一致：若 `m.change_password.enabled = false`、`m.3pid_changes.enabled = false` 或 `m.get_login_token.enabled = false`，则对应公开路由必须继续维持相同真值，不得出现 capability 与 route handler 漂移。

### 5.2 Profile Truth and Propagation

* profile truth 的权威表是 `DATA-USER-012`，独立于 account data。
* `v1.17` 基线下，必须支持 `displayname`、`avatar_url`、`m.tz` 以及 policy 允许的 namespaced custom fields。
* `GET /_matrix/client/*/profile/{userId}` 在 disclosure 已被允许时，必须返回该用户当前可公开的完整 profile truth 子集；除 `displayname`、`avatar_url` 外，还必须包含已设置的 `m.tz` 与 policy 允许公开的 namespaced custom fields。
* `PUT /_matrix/client/*/profile/{userId}/{keyName}` 的请求体必须是“恰好一个属性”的 JSON object，且该属性名必须与 URL 中的 `keyName` 完全一致。
* `keyName` 只允许 `displayname`、`avatar_url`、`m.tz` 或满足 namespaced grammar 的自定义字段；`displayname` 必须是 string，`avatar_url` 必须是 MXC URI，`m.tz` 必须是 IANA 时区标识。
* `keyName` 的 UTF-8 字节长度必须不超过 `255`；超限必须返回 `M_KEY_TOO_LARGE`。
* 自定义 namespaced key 的 value 允许是任意合法 JSON 值；只有 `displayname`、`avatar_url`、`m.tz` 三类规范字段受额外类型约束。
* `GET /_matrix/client/*/profile/{userId}/{keyName}` 必须接受与写路径相同的 `keyName` 集合；当 disclosure 已被允许时，若该字段存在则返回“恰好一个同名属性”的 object，若字段不存在则返回 `404 M_NOT_FOUND`。
* 请求体无法按 JSON object 成功解析时，必须返回与该 endpoint contract 对齐的固定 `400` 输入错误；首选 `M_BAD_JSON`，不得再把 `M_NOT_JSON` 写成本实现的唯一 MUST。
* 请求体是合法 JSON object 但缺少与 `keyName` 对应的属性、存在额外顶层属性、`keyName` 不满足允许集合/grammar、或值形状不符合该字段约束时，必须按本实现固定映射返回 `M_MISSING_PARAM`、`M_BAD_JSON` 或 `M_INVALID_PARAM` 中与该类输入错误绑定的那一个；推荐分别对“缺少目标属性”“body 形状错误”“非法 keyName”使用 `M_MISSING_PARAM`、`M_BAD_JSON`、`M_INVALID_PARAM`，并由测试覆盖，不得随节点漂移。
* 服务端可以拒绝 `null` 值；若接受 `null`，则必须按 `null` 存储，而不是把它解释成删除。删除字段只能走 `DELETE /_matrix/client/*/profile/{userId}/{keyName}`。
* `DELETE /_matrix/client/*/profile/{userId}/{keyName}` 必须接受与写路径相同的 `keyName` grammar，并保持幂等：字段存在时删除它，字段不存在时仍返回成功；`displayname` 或 `avatar_url` 被删除时，必须触发与写入这两个字段相同的 propagation 路径。
* 更新后的 total profile document 必须小于 `64 KiB`；超限时必须按协议返回 `M_PROFILE_TOO_LARGE`。
* successful profile write 必须先原子更新 `DATA-USER-012`，再启动传播路径。
* 每次成功的 profile truth 变更都必须在同一事务里生成新的、单调递增的 `profile_version`；该版本号是 profile propagation、重放与去重的唯一排序键。
* `displayname` 或 `avatar_url` 变更时，homeserver 必须自动产生两类传播：
  * 带新 profile 值的 presence 增量；
  * 对该用户当前已加入的每个本地房间生成新的 `m.room.member` `join` refresh 事件。
* 传播可以异步分片执行以适应 Cloudflare 限制，但必须按 `{user_id,profile_version,room_id}` 幂等，并且不得丢失较新的 profile 版本。
* public profile read 与 federation profile query 都必须先执行可见性 / disclosure policy 裁决，再执行 existence 裁决。
* client public profile read 可以公开 `m.tz` 与 policy 允许的 namespaced custom fields；federation `query/profile` 仍受 server-server `v1.17` 限制，只允许 `displayname` / `avatar_url`。
* 当 homeserver 策略是不愿披露目标用户或字段是否存在时，例如 profile lookup disabled、目录/隐私策略禁止 disclosure，必须返回 `403 M_FORBIDDEN`。
* 只有在 disclosure 已被允许、但目标 user 或 field 实际不存在时，才允许返回 `404 M_NOT_FOUND`；不得把 policy denial 伪装成 `404`，也不得在 `403` 与 `404` 之间随机漂移。

### 5.3 Account Data

* global account data 的权威表是 `DATA-USER-006`。
* room account data 的权威表是 `DATA-USER-007`，即使其语义关联房间，也不属于 `RoomDO`。
* `m.direct`、ignored users、tags、`m.marked_unread` 等都属于 account data / read-marker 家族，不属于 profile truth。
* account data 变更必须进入 `user_stream`，供 `/sync` 发出增量。

### 5.4 Push Rules and Notification State

* custom push rules、enabled 状态和规则顺序的权威表是 `DATA-USER-013`。
* Matrix `v1.17` 默认 push rules 必须由服务端按规范基线精确合成；用户存储只保存覆盖、禁用和顺序调整。
* 规范性基线固定在 [92-appendices.md](/root/Matrix/spec/framework/92-appendices.md) 的 “Matrix `v1.17` Default Push-Rules Baseline” 附录中；运行时生成的 server-default rules 必须与该附录逐条等价，包括 `kind`、顺序、`rule_id`、`enabled` 默认值、conditions 与 actions。
* `v1.17` 的 server-default baseline 中，`content`、`room`、`sender` 三类默认规则集为空；同时 `v1.17` 已移除 legacy “在 `content.body` 中寻找 mention” 的默认规则，不得再合成旧规则。
* 必须支持 `GET /pushrules/`、`GET /pushrules/global/`、`GET/PUT/DELETE /pushrules/global/{kind}/{ruleId}`、`GET/PUT /pushrules/global/{kind}/{ruleId}/actions`、`GET/PUT /pushrules/global/{kind}/{ruleId}/enabled` 这些 `v1.17` 路由面。
* `kind` 只允许 `override`、`underride`、`sender`、`room`、`content`；用户自定义 `ruleId` 不得以 `.` 开头，且不得包含 `/` 或 `\\`。
* `PUT /pushrules/global/{kind}/{ruleId}` 在创建**或更新**规则时，若没有 `before` / `after`，该规则必须成为同类用户自定义规则中最高优先级；若同时给出 `before` 和 `after`，必须以 `before` 为主确定新顺序。
* `before` / `after` 只能相对于同类 `kind` 中的**用户自定义规则**定位；禁止把用户规则插入 server-default rules 之间，也禁止借此改变 [92-appendices.md](/root/Matrix/spec/framework/92-appendices.md) 中钉死的 server-default 相对顺序。
* 新创建的 push rule 必须默认 `enabled = true`。
* `/actions` 与 `/enabled` 子资源只允许修改对应字段，不得隐式重写条件、pattern 或顺序。
* push rule 写入必须由 `UserDO` 线性化，并在后续 `/sync` 中生效。
* push rule 评估必须使用“用户 overrides snapshot + 规范默认基线”的组合视图；不得把默认规则物化进用户表后再在读时猜测真实顺序。
* 为控制 Cloudflare CPU 和滥用面，单用户自定义 push rules 默认上限为 `256` 条；单条规则最多 `32` 个 conditions；用户 overrides 的总 canonical JSON 体积默认上限为 `64 KiB`。
* unread counters、notification counts 和 `unread_thread_notifications` 必须由 `RoomDO` delta 与当前 push-rules snapshot 共同计算，再进入 `user_stream`。
* private / threaded receipts 与 read markers 是计数输入；但 receipt 当前视图仍由 `RoomDO` 权威持有。
* 计数更新失败不得改写房间 timeline truth，但必须可由房间真相和 push-rules snapshot 重算修复。

### 5.5 To-Device

* to-device 消息权威表是 `DATA-USER-008`。
* `PUT /sendToDevice/{eventType}/{txnId}` 的幂等裁决必须持久化在 `DATA-USER-016`；同一 `{sender_user_id,event_type,txn_id}` 加同一 `request_fingerprint` 重试时，必须返回与首次提交等价的成功结果。
* 若同一 `{sender_user_id,event_type,txn_id}` 对应不同 `request_fingerprint`，必须返回 deterministic idempotency conflict，不得重复入队。
* to-device 投递顺序以目标设备视角按照 `user_stream_pos` 递增。
* 当客户端发起新的 `/sync?since=X` 时，`UserDO` 才可以认定该 session 已经观察到 `X` 之前的用户流，从而清理对该 session 已确认的 to-device 记录。
* 对长期离线 session，允许按保留策略进行 TTL 清理，但必须记录为协议可见的丢弃策略，不得静默假定已送达。

### 5.6 Presence

* presence 当前值由 `DATA-USER-009` 持有。
* presence 更新必须线性化进入 `user_stream`，避免 `/sync` 与 `/presence` 读面不一致。
* profile `displayname` / `avatar_url` 变更触发的自动 presence refresh 也必须走同一线性化路径。
* presence 传播是最终一致 fanout，但本用户的当前值读取必须强一致。

### 5.7 Device Management

* device metadata 的权威表是 `DATA-USER-002`；只有 `deleted_at = null` 的设备才属于当前可见 device list truth。
* `GET /_matrix/client/*/devices` 与 `GET /_matrix/client/*/devices/{deviceId}` 只允许读取当前认证用户自己的 active devices；已删除设备必须表现为不存在。
* 在当前 profile 下，`PUT /_matrix/client/*/devices/{deviceId}` 仅允许普通客户端更新现有 device 的 metadata；Matrix `v1.17` 中 application service 可创建新 device 的分支不在当前产品边界内，不得对普通客户端误开放。
* `PUT /_matrix/client/*/devices/{deviceId}` 当前只允许修改 `display_name`；若请求体缺省该字段，则必须保持现有 display name 不变。
* `DELETE /_matrix/client/*/devices/{deviceId}` 与 `POST /_matrix/client/*/delete_devices` 必须使用 route-bound UIA challenge；当请求携带 access token 时，UIA 主体必须与当前 session 的 `user_id` 完全一致。
* 删除 device 成功时，`UserDO` 必须在同一原子提交中：
  * 使目标 `DATA-USER-002` device 进入 deleted truth；
  * 撤销所有绑定到这些 devices 的 access/refresh sessions；
  * 使对应的 device keys、one-time keys、fallback keys 与 to-device pending delivery 不再对外可见；
  * 对任何受影响的 device key / cross-signing 观察者生成后续 `/sync` 所需的 device-state 增量。
* device delete 必须保持幂等：已删除 device 再次删除时返回成功；同一 UIA challenge 若被重放到不同 device set，则必须 deterministic conflict，而不是部分复用旧裁决。

## 6. E2EE 传输边界

### 6.1 本分册负责的内容

本分册只负责 E2EE 传输与存储边界，不负责解密语义：

* device keys 上传与查询
* one-time / fallback keys claim
* cross-signing key material 与 cross-signing signatures 的上传与读取
* room key backup 元数据与密文备份对象
* to-device 加密负载投递
* `/sync` 中 `device_lists`、`device_one_time_keys_count`、`device_unused_fallback_key_types`

### 6.2 明确不负责的内容

* 不在服务端执行 Megolm/Olm payload 解密；
* 不在服务端解释房间密钥业务内容；
* 不把服务端 key backup 设计成客户端明文密钥托管。

### 6.3 关键规则

* `/keys/claim` 必须保证 one-time key 至多返回一次。引用：`REQ-ARCH-011`,`DATA-USER-004`。
* fallback key 可以重复返回直至被替换或按协议标记失效，但它的使用状态必须进入 `/sync`。
* `POST /_matrix/client/*/keys/device_signing/upload` 对普通 client 必须遵循 Matrix `v1.17` 的 conditional UIA 语义：首次 master key 上传可免 UIA，完全等价的 key-set 重放可免 UIA，其余 regular-client key-set 变更必须走 route-bound UIA。
* `POST /_matrix/client/*/keys/signatures/upload` 只允许向当前 homeserver 已知的 device key / cross-signing object 追加与该 object 主体一致的 signatures；任何 signed JSON object 若与既有主体不匹配，必须返回 deterministic per-key failure，不得 silent overwrite。
* 任何设备 key 或 cross-signing 变更都必须生成 `device_lists` 增量。
* room key backup 的版本元数据由 `DATA-USER-011` 持有；大体量密文分片可写入 `DATA-R2-006`，服务端只保证完整性和版本隔离，不解释密钥明文。

## 7. `/sync` 目标与令牌模型

### 7.1 设计目标

`/sync` 是设备视角增量流接口，不是普通查询接口。必须满足：

* 单调前进的 `next_batch`
* 对空闲客户端的 long-poll 行为
* 聚合用户域、房间域、to-device、presence、E2EE 元数据
* 成本在 Cloudflare 上可控

### 7.2 Token 规则

`next_batch` 对客户端必须完全 opaque。规范性规则如下：

* token 至少包含版本前缀与 `user_stream_pos`。引用：`DATA-ID-001`。
* token 不得要求服务端保留 mutable waiter state 才能解析。
* token 必须具备完整性保护，防止客户端通过篡改 `user_stream_pos`、`device_id` 或 `filter_hash` 伪造更远的游标；任何签名/校验失败都必须 deterministic `400 M_INVALID_PARAM`。
* token 可选包含 `device_id_hash`、`filter_hash`、`capability_bits` 以做误用检测，但授权仍以 access token 为准。
* 无新数据时允许返回新的 `next_batch` 等于旧 token 对应位置。

### 7.3 用户流模型

`UserDO` 必须维护单调递增的 `user_stream_pos`，以下变化都必须写入 `DATA-USER-010`：

* room delta
* invite / leave / knock delta
* account data 变化
* to-device
* presence
* device lists changed / left
* one-time key count
* fallback key types
* receipt / typing 聚合更新
* 由 `RoomDO` durable outbox 成功交付并被 `UserDO` durable append 的房间 fanout

### 7.4 `/sync` 请求标准化

`gateway-worker` 在 dedupe、waiter 管理与 `collectSince()` 调用前，必须先把公开请求归一化为稳定 `SyncRequestKey`：

* `session_id`
* `device_id`
* `since_kind`：`initial` 或 `incremental`
* `since_pos`
* `filter_hash`
* `full_state`
* `use_state_after`
* `set_presence`
* `timeout_ms_normalized`

其中：

* `timeout_ms_normalized = min(max(requested_timeout_ms,0), configured_sync_timeout_max_ms)`
* stored filter 与 inline filter 都必须先解析到同一个 `canonical_filter_hash`
* waiter 去重必须基于 `SyncRequestKey`，而不是原始 query string
* 若两个并发请求只有 `timeout_ms_normalized` 不同，则实现可以保留较新的请求并结束较旧请求，但不得让二者同时长期驻留
* 若请求未显式给出 `timeout`，其规范默认值必须按 Matrix `v1.17` 解释为 `0`，即服务器在无新数据时也要立即返回，而不是擅自升级为长轮询。
* 若请求未显式给出 `set_presence`，其规范默认值必须按 Matrix `v1.17` 解释为 `online`；`set_presence = offline` 只表示“本次 `/sync` 不把该会话标成 online”，`set_presence = unavailable` 表示 idle，且这些 `/sync` 自动 presence touch 不得顺带清空既有 `status_msg`。
* `/sync` 自动 presence touch 只有在 `since` token、filter 绑定、session/device 等请求校验通过后才允许写入 `DATA-USER-009` / `DATA-USER-010`；任何 deterministic `4xx` `/sync` 错误都不得产生 presence side effect。

## 8. Worker-Held Long Poll 设计

### 8.1 规范性结论

* `/sync` 长轮询必须由 `gateway-worker` 持有，不得由 `UserDO` 直接持有 HTTP 请求。引用：`CF-WKR-001`,`CF-DO-009`。
* `UserDO` 只负责用户流推进和唤醒信号，不负责占用公网等待连接。

### 8.2 请求处理流程

1. `gateway-worker` 调用 `IF-INT-USER-001` 解析 access token。
2. 规范化 filter、`set_presence`、`timeout` 与 `since`，并完成 `SyncRequestKey` 校验。
3. 调用 `IF-INT-USER-002` 获取当前是否已有用户流增量。
4. 若该请求在通过校验后仍需按 `/sync` 语义更新当前 presence，则调用 `IF-INT-USER-007` 写入 `DATA-USER-009` / `DATA-USER-010`。
5. 若 step 4 产生了新的用户流写入，则重新执行 `IF-INT-USER-002`。
6. 若已有增量，立即投影并响应。
7. 若无增量，创建本地 waiter，并通过唤醒通道等待。
8. 被唤醒后再次执行 `collectSince`。
9. 对涉及房间的 delta 调用 `IF-INT-ROOM-002`。
10. 组合响应并返回新的 `next_batch`。

### 8.3 唤醒通道

首选实现：

* `UserDO` 作为 WebSocket Hibernation server；
* `gateway-worker` 为每个活跃长轮询建立轻量唤醒连接；
* 唤醒消息只携带“用户流至少推进到某位置”的摘要，不携带业务 payload。

降级实现：

* 若 hibernation 通道不稳定，则使用低频自适应轮询 `collectSince`；
* 但“Worker 持有长轮询”的原则不变。

### 8.4 并发与背压

* 同一 `session_id` 同一参数集只允许一个活跃 `/sync` waiter。
* 对并发重复请求，服务端应优先保留最新请求并尽早结束旧请求，避免双倍成本。
* `UserDO` 唤醒消息必须可合并；只要 Worker 知道“位置前进了”，就不需要每条流记录单独唤醒。

## 9. `/sync` 响应组装规则

### 9.1 快照边界与 `next_batch`

* `/sync` 响应的房间部分由 `RoomDO.projectForSync()` 提供局部投影，而不是由 `UserDO` 拼接房间详情。
* `collectSince()` 必须先给出单一 `upper_bound_user_stream_pos`；本次响应中的 user-scoped 与 room-scoped 数据都必须以该边界为上限。
* `next_batch` 只能在所有 user-domain 片段与所有房间投影都成功组装后前推到 `upper_bound_user_stream_pos`。
* 若任一房间投影失败，则本次 `/sync` 不得推进 `next_batch`。
* to-device、device lists、one-time key count 和 fallback key types 都必须来自与 `since` 同一用户流快照边界。
* `RoomProjectionRequest` 至少必须包含 `user_id`,`room_id`,`room_pos`,`membership_bucket`,`filter_hash` 与本次 `/sync` 的 visibility context；不得只用 `{room_id,room_pos,filter_hash}` 这类可跨用户碰撞的键推导房间投影。

### 9.2 Initial / Incremental 语义

* `since` 缺失表示 initial sync；实现必须在单一 `upper_bound_user_stream_pos` 上返回用户当前可见的 joined / invited / knocked 房间视图与当前用户域快照；`rooms.leave` 只在 filter 显式启用 `include_leave = true` 时返回 left / banned-but-not-forgotten 房间。
* `since` 存在表示 incremental sync；实现只能返回满足 `stream_pos > since_pos && stream_pos <= upper_bound_user_stream_pos` 的增量。
* token 解析失败、版本不兼容、设备或用户作用域不匹配时，必须在进入 long poll 前失败，并且不得前移任何 session ack 状态。

### 9.3 房间投影最小形态与 membership 可见性

`RoomDO.projectForSync()` 在适用字段上至少必须能输出：

* `room_id`
* `membership_bucket`
* `timeline_events`
* `limited`
* `prev_batch`
* `state_payload`
* `ephemeral`
* `account_data`
* `unread_notifications`
* `summary`

membership 到 `/sync` bucket 的映射必须固定为：

* `join` -> `rooms.join`
* `invite` -> `rooms.invite`，且只返回 stripped invite state
* `knock` -> `rooms.knock`，且只返回 stripped knock state
* `leave` / `ban` -> `rooms.leave`，但仅当本次请求的 filter 启用 `include_leave = true`；否则必须从响应中省略，直到未来某次请求显式要求包含 leave rooms
* forgotten rooms 不得再出现在任何 bucket 中

若同一房间在 `(since, upper_bound]` 窗口内跨多个 membership bucket 迁移，响应中必须只出现最终 bucket；为解释最终 bucket 所必需的 timeline / state 仍必须一并返回。

### 9.4 `limited` 与 `prev_batch`

* 当服务端因为 `timeline.limit`、repair gap、backfill 边界或可见性压缩而省略了更早但本应可见的 timeline 事件时，房间投影必须设置 `limited = true`。
* 只要返回了 `timeline.events`，就必须返回 `prev_batch`；其中 `prev_batch` 必须绑定 `DATA-ID-002`，由 `RoomDO` 签发为 opaque cursor，且能独立支持向后分页，不依赖 mutable waiter state。
* 当 `limited = true` 时，`prev_batch` 必须指向“最老一条已返回 timeline event 之前”的房间位置。
* 当没有返回 timeline events 时，`prev_batch` 可以省略。

### 9.5 Filter 应用、`full_state` 与 `use_state_after`

* `UserDO` 必须先应用 user-scoped filter 分支，例如 account data、presence、to-device、device lists；`RoomDO` 必须应用 room-scoped filter 分支，例如 room include/exclude、timeline、state、ephemeral。
* `full_state = true` 时，服务端必须忽略 `timeout`，并且对适用房间返回 `upper_bound_user_stream_pos` 对应时刻的完整当前可见状态，即使这些状态事件的 stream position 不在 `(since, upper_bound]` 内；该完整状态仍受 filter 的 state 维度约束。
* `use_state_after = true` 时，`rooms.join` 与 `rooms.leave` 中凡返回 timeline/state delta 的房间都必须输出 `state_after`，其含义是“应用本次返回的 timeline events 之后的当前状态”；此时必须省略 legacy `state`，且 `state_after` 即使为空数组也必须显式出现。
* 同一房间在同一次 `/sync` 响应中不得混用 `state` 与 `state_after`。
* 当启用 `lazy_load_members` 时，成员事件只能按 Matrix `v1.17` lazy-load 规则输出：至少必须包含本次 timeline 中事件 sender 所需的 member state、`state`/`state_after` 中显式返回的 member state，以及客户端自己在 joined 房间中的 membership event；若同时启用 `full_state = true`，则 joined 房间中客户端自己的 membership event 仍必须返回。
* 当 `lazy_load_members = true` 且 `include_redundant_members = false` 时，服务端可以省略“此前已向同一设备会话返回过、且这次并非再次必需”的成员事件；当 `include_redundant_members = true` 时，这些成员事件必须重新发送。
* unread / notification counts 必须使用 `upper_bound_user_stream_pos` 时刻的 push-rules snapshot 计算，而不是使用响应开始时或结束时的漂移视图。
* 任一房间投影失败都必须使整个 `/sync` 失败并保持 `next_batch` 不前移；禁止返回“部分房间成功、部分房间失败”的 `200` 响应，必须返回明确错误并允许客户端按相同 `since` 安全重试。

## 10. 失败、重试与成本控制

* runtime 更新导致的长轮询中断应当表现为正常早返回，客户端重试即可。引用：`CF-DO-010`。
* wake 通道断开时，Worker 应执行一次最终 `collectSince`，然后返回空或增量响应，不得悬挂。
* 默认长轮询 timeout 建议 `30s`，避免大量长连接无限驻留。
* typing 与 receipts 必须在 `UserDO` 或 `RoomDO` 侧先聚合，再进入用户流。

## 11. 客户端域接口归属

| Capability | Public IF | Internal IF | Primary Data |
| --- | --- | --- | --- |
| register discovery/availability + login discovery/exchange + logout/refresh/whoami | `IF-CS-005`,`IF-CS-009`,`IF-CS-010`,`IF-CS-011`,`IF-CS-012`,`IF-CS-013`,`IF-CS-014`,`IF-CS-067` | `IF-INT-USER-001` | `DATA-USER-001`,`DATA-USER-017`,`DATA-ID-006` |
| password change / deactivate | `IF-CS-006`,`IF-CS-008` | `IF-INT-USER-001` | `DATA-ID-006`,`DATA-USER-001`,`DATA-USER-017` |
| registration/password-reset requestToken bootstrap | `IF-CS-007` | none | `none` |
| capabilities / filters | `IF-CS-002`,`IF-CS-003`,`IF-CS-004` | none | `DATA-USER-014` |
| profile | `IF-CS-017` | none | `DATA-USER-012` |
| device management | `IF-CS-040` | `IF-INT-USER-001` | `DATA-USER-002`,`DATA-USER-003` |
| account data / tags / read-unread markers | `IF-CS-015` | `IF-INT-USER-002` | `DATA-USER-006`,`DATA-USER-007` |
| push rules | `IF-CS-018` | none | `DATA-USER-013` |
| presence | `IF-CS-016` | `IF-INT-USER-002` | `DATA-USER-009`,`DATA-USER-010` |
| to-device | `IF-CS-041` | `IF-INT-USER-005` | `DATA-USER-008`,`DATA-USER-010`,`DATA-USER-016` |
| keys / cross-signing / backup | `IF-CS-042`,`IF-CS-043`,`IF-CS-044`,`IF-CS-045`,`IF-CS-046`,`IF-CS-047` | `IF-INT-USER-004` | `DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-011`,`DATA-R2-006` |
| `/sync` | `IF-CS-020` | `IF-INT-USER-002`,`IF-INT-USER-007`,`IF-INT-ROOM-002` | `DATA-ID-001`,`DATA-USER-009`,`DATA-USER-010` |

## 12. 完成标准

* 客户端域责任边界闭合；
* `/sync` 模型能直接指导实现；
* E2EE 传输边界与非边界清楚；
* 客户端域已接入接口、数据、流程目录；
* 与房间域和安全域的接口无重叠。
