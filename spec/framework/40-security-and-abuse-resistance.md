# Security and Abuse Resistance Spec

状态：Draft-Normative
角色：安全分册
负责主文档章节：5
继承的单体章节：19

## 1. 文档职责

* 定义认证、授权、密钥、秘密材料、租户隔离与滥用防护。
* 定义安全边界、访问控制与审计要求。
* 定义必须下沉到实现和运维层的安全约束。

明确不包含：

* 不定义联邦交易流程正文；
* 不定义部署流水正文；
* 不定义性能容量正文。

## 2. 安全基线要求

| REQ-ID | Requirement | Normative Statement |
| --- | --- | --- |
| `REQ-SEC-001` | Token truth | access token 与 refresh token 的有效性只以 `UserDO` 真相为准。 |
| `REQ-SEC-002` | Secret storage | 所有敏感密钥、bearer token 本体与可离线重放的凭据都必须存放于 Workers secrets 或 Secrets Store；不适用于仅以 hash 形式存于 `UserDO` 真相中的 access/refresh token。 |
| `REQ-SEC-003` | No plaintext secrets | 严禁把敏感信息存入 Wrangler `vars`、D1、KV、Git 或日志。 |
| `REQ-SEC-004` | Room authorization | 房间级授权最终只由 `RoomDO` + room version auth rules 裁决。 |
| `REQ-SEC-005` | Federation auth | 除显式登记为 deterministic disabled stub 的联邦路由外，联邦请求只以 `X-Matrix` 签名和 Matrix 规则验证，不以 IP allowlist 替代。 |
| `REQ-SEC-006` | Abuse controls | 注册、登录、媒体、房间发送、联邦入口、搜索等都必须具备限流或配额控制。 |
| `REQ-SEC-007` | Auditability | 所有高权限操作都必须有审计记录与因果链。 |
| `REQ-SEC-008` | Single-tenant isolation | 首版隔离边界是“每个 homeserver 域名独立部署单元”。 |

## 3. 认证模型

| Actor / Path | Authentication Method | Runtime Owner | Notes |
| --- | --- | --- | --- |
| Client request | access token | `gateway-worker` + `UserDO` | 通过 `IF-INT-USER-001` 解析。 |
| Refresh flow | refresh token | `gateway-worker` + `UserDO` | 轮换后旧 token 必须失效。 |
| Appservice request | AS token | `gateway-worker` | token 本体存 secrets。 |
| Federation request | `Authorization: X-Matrix` | `gateway-worker` + `RemoteServerDO` | 需远端 key 获取与签名校验。 |
| Internal Worker/DO call | platform trust + explicit contract | Worker / DO runtime | 不暴露公网。 |
| Operator request | Cloudflare Access JWT / Access service token + scope check | `ops-worker` | 不允许复用普通 client token。 |

### 3.1 客户端认证规则

* access token 与 refresh token 只存 hash。引用：`DATA-ID-003`,`DATA-ID-004`。
* `logout`、`logout/all`、device deletion、session expiry 都必须立即使后续 token 校验失效。
* `/sync`、媒体、房间写入都必须在进入业务处理前完成认证。

### 3.2 联邦认证规则

* `IF-FED-009`,`IF-FED-010` 这类已在接口目录登记为 deterministic disabled stub 的联邦路由，必须按固定 stub wire contract 在鉴权前短路；这是 `REQ-SEC-005` 的显式例外，而不是实现漂移。
* 每个联邦请求都必须先验证 `origin`、签名、key 有效期和目标 server name。
* 验签失败不得进入 `RoomDO` 或 `UserDO`。
* 远端 key cache 命中只能优化性能，不能绕过过期与重拉取逻辑。
* `Authorization: X-Matrix`、`Cf-Access-Jwt-Assertion`、`Idempotency-Key` 与其它安全相关 headers 都必须受 Workers `128 KB (total)` request/response header ceiling 约束；不得把可增长的声明、签名材料、manifest 或审计上下文膨胀到 header 中。引用：`CF-WKR-024`。

### 3.3 运维认证规则

* 人类运维请求必须经 Cloudflare Access 保护的专用管理域进入；`ops-worker` 必须验证 Access identity、`aud`、`exp` 与 issuer 绑定。引用：`CF-NET-004`,`CF-NET-005`。
* 自动化运维请求必须使用 Access service token 或等价受限凭据，且同样只能打到专用管理域。
* `ops-worker` 必须把 Access subject / service principal 映射为内部 `operator_principal_id`，并按 `DATA-D1-006` 裁决 scope。
* 每个控制面写请求都必须通过 HTTP `Idempotency-Key` 头携带 `idempotency_key`；`ops-worker` 必须用 `DATA-OPS-004` 检测重放并把重复请求折叠为同一作业或显式拒绝。
* 运维入口的凭据撤销与轮换必须依赖 Cloudflare Access / service token 生命周期，而不是长寿命静态 bearer token。引用：`CF-NET-006`。

#### 3.3.1 接受的 Access 身份传输形态

* `ops-worker` 只接受通过 Cloudflare Access 成功鉴权后附带的 Access JWT 作为应用层身份依据；规范首选 `Cf-Access-Jwt-Assertion`。
* `CF-Access-Client-Id` / `CF-Access-Client-Secret` 只被视为 Access 边缘策略的入站凭据，不得被 `ops-worker` 当作应用层 bearer secret 直接信任。
* `Cf-Access-Authenticated-User-Email`、common-name 等 Access 注入头只能用于日志和展示，不得单独作为授权依据。
* 不得把 `CF_Authorization` cookie 当成唯一身份源；只有在 `Cf-Access-Jwt-Assertion` 缺失且已存在显式 `DEC-ID` 豁免时，才允许讨论替代路径。默认实现必须 fail-closed。引用：`CF-NET-004`。
* Access JWT、service-token ingress headers、cookie 与任何附加 auth metadata 的组合也必须遵守 Workers header 总量上限；若未来引入额外 claims 或转发链路，不得依赖“header 无限大”假设。引用：`CF-WKR-024`。

#### 3.3.2 `ops-worker` JWT 验证与裁决步骤

`ops-worker` 对每个管理面请求必须按以下固定顺序处理：

1. 读取 `Cf-Access-Jwt-Assertion`，缺失则直接返回 `401`。
2. 使用 Access team domain 的 `/cdn-cgi/access/certs` JWK/cert 集按 JWT `kid` 验证签名；实现必须缓存当前和上一个有效 key，并在 `kid` miss 时先强制刷新一次 JWK 集再裁决。不得把单一 `public_cert` 硬编码为唯一信任根。引用：`CF-NET-005`。
3. 校验 `iss`、`aud`、`exp`、`nbf`、`sub`；任一失败都必须返回 `401`。
4. 以 `{iss,aud,stable_subject}` 映射 `DATA-D1-006 principal_id`；其中 human 默认取 JWT `sub`，service principal 必须取部署时明确登记的“稳定服务主体 claim 优先级列表”中的首个命中项；若没有稳定 claim 命中，则必须返回 `401/403`，不得退化为展示性邮箱或空 `sub`。
5. 按 `allowed_scopes` 与 `target_scope_constraints` 裁决授权；失败返回 `403`。
6. 对写请求读取 `idempotency_key` 并查询 `DATA-OPS-004` dedupe projection；冲突返回 `409`。
7. 先写入审计事件，再创建或驱动作业。

自动化运维的规范路径是：

* Access service token 只用于通过 Cloudflare Access 策略；
* 到达 `ops-worker` 时仍必须表现为可验证的 Access JWT；
* 对于 service-auth only 的 Access 应用，自动化调用方通常需要在每次请求继续向 Access 发送 service token；但 `ops-worker` 仍只信任经 Access 生成并注入的 JWT。
* 因此 `ops-worker` 无需持有或比较 service token secret 本体。

## 4. 授权模型

### 4.1 用户域授权

* 用户只能修改自己的 devices、sessions、account data、presence 和 keys。
* 任何跨用户读取都必须有 Matrix 协议允许的可见性依据。

### 4.2 房间域授权

* 房间发送、state 更新、membership 变化都必须经过 `RoomDO` 授权。
* `gateway-worker` 不得自行决定用户是否可加入、邀请、封禁或 redaction。

### 4.3 运维授权

* 导出、修复、回放、迁移、重建只能通过 `ops-worker` 控制面执行。
* 运维 token 或 `operator_principal_id` 不能直接调用 `RoomDO`/`UserDO` 私有方法绕过审计。

## 5. Secret Material and Signing Keys

| Secret Class | Allowed Storage | Forbidden Storage | Rotation Rule | Related CF IDs |
| --- | --- | --- | --- | --- |
| homeserver signing key | Workers secrets / Secrets Store | `vars`, D1, KV, Git | 进入正式发布流程并保留旧公钥验证窗口 | `CF-WKR-013`,`CF-WKR-014` |
| session HMAC / token root key | Workers secrets / Secrets Store | `vars`, D1, KV, Git | 通过版本化部署轮换，支持双读验证窗口，并保留旧 verify key 直到 rollout overlap 与最大 token TTL 同时结束 | `CF-WKR-012`,`CF-WKR-013`,`CF-WKR-014`,`CF-WKR-020`,`CF-WKR-021` |
| appservice tokens | Workers secrets / Secrets Store | `vars`, D1 plaintext, KV | 与 appservice config 变更一起发布 | `CF-WKR-013`,`CF-WKR-014` |
| OTel / external integration credentials | Workers secrets / Secrets Store | `vars`, D1, KV | 与集成变更耦合发布 | `CF-WKR-013`,`CF-WKR-014` |
| export bundle encryption key | Workers secrets / external KMS if adopted | `vars`, D1, KV | 必须可审计轮换 | `CF-WKR-013` |

### 5.1 Secrets 使用规则

* 必须使用 secrets 而不是 `vars` 保存敏感信息。引用：`CF-WKR-013`。
* secret 变更会生成新的 Worker version；渐进发布场景必须使用 `wrangler versions secret put/delete`。引用：`CF-WKR-014`。
* 任何 secret-backed stateless token keyring 都必须显式控制活跃 key 数量与序列化体积；若以 Worker secret 注入，必须满足单 secret `5 KB` 上限。引用：`CF-WKR-020`。
* 默认应避免多 Worker 共享同一签名 secret；若确需共享，必须使用 Secrets Store 或受控的 duplicated versioned secrets，并保证所有参与验证的 Worker 看到同一 `root_key_version -> key` 映射。引用：`CF-WKR-021`。

## 6. Abuse Resistance

| Abuse Surface | Required Control | Runtime Owner |
| --- | --- | --- |
| register / login / refresh | per-IP, per-user, per-session rate limit | `gateway-worker`,`UserDO` |
| `/sync` | per-session single waiter, timeout cap, duplicate request suppression | `gateway-worker`,`UserDO` |
| room send / membership | per-user, per-room send rate and membership mutation guardrails | `RoomDO`,`UserDO` |
| media upload | size limit, byte budget, pending upload count, MIME policy | `gateway-worker`,`UserDO` |
| federation inbound | per-origin transaction size, frequency, malformed request counters | `gateway-worker`,`RemoteServerDO` |
| search / directory | query rate limit and pagination bound | `gateway-worker`,`jobs-worker` |
| URL preview | SSRF allowlist/denylist, response size cap, redirect cap | isolated preview runtime |
| control plane | strong auth, allowlist, audit, no public anonymous reachability | `ops-worker` |

### 6.1 Rate Limit Placement

* 粗粒度入口限流放在 `gateway-worker`。
* `gateway-worker` 的 coarse edge shaping 若采用 Workers `ratelimits` binding，只能把它当作 per-location、permissive 的前置护栏；任何 correctness-sensitive 的用户、会话、媒体、membership 或房间写语义配额，仍必须在应用拥有者侧实现。引用：`CF-WKR-027`。
* 语义级配额和并发控制放在主权对象内实现。
* Cloudflare 平台防护可作为附加防线，但不能替代业务语义配额。

## 7. Tenant and Data Isolation

* 首版隔离单元是“每个 homeserver 独立 Cloudflare 资源集合”。
* 必须为每个环境提供独立 Worker、DO namespace、D1、R2、KV、Queues、secrets。
* staging 与 production 绝不能共享权威状态命名空间。

## 8. Administrative Access and Audit

### 8.1 运维入口

* 运维入口默认只经 `ops-worker` 暴露。
* 若使用 Cloudflare Access 或其他接入控制，也不得依赖 URL 端口作为安全边界。引用：`CF-NET-003`。
* 控制面不得暴露直接访问 `RoomDO` / `UserDO` / `RemoteServerDO` 的公网接口。

### 8.2 必须审计的事件

* secret rotation
* deployment and rollback
* DO migration
* export / import / replay / rebuild / repair
* appservice config change
* high-severity auth and federation failures

### 8.3 审计日志契约

* 所有 8.2 中的事件都必须首先写入 `DATA-OPS-004`，再返回控制面结果。
* `DATA-OPS-004` 必须至少记录 `operator_principal_id`、auth mechanism、scope、request_id、idempotency_key、request_fingerprint、causation_id、结果码与影响对象。
* Workers Logs 只用于运维遥测，不得被视为长期审计存储或不可抵赖证据来源。

## 9. Privacy and Data Handling Boundaries

* 日志中禁止记录 token 明文、签名私钥、敏感密钥材料、未脱敏凭据。
* to-device 与 room key backup 内容被视为 opaque / highly sensitive，不进入 D1 搜索索引。
* 媒体和导出包若包含敏感内容，必须存于私有 R2 bucket，并只通过受控路径下载。

## 10. 安全域测试入口

| Area | TEST IDs | EVID IDs |
| --- | --- | --- |
| auth, token revocation, and baseline abuse guards | `TEST-SEC-001` | `EVID-SEC-001` |
| advanced abuse hardening and external-provider surfaces | `TEST-SEC-002` | `EVID-SEC-001` |
| deployment/secret coupling | `TEST-OPS-001` | `EVID-OPS-001` |

## 11. 完成标准

* 所有敏感边界都有明确控制规则；
* 各协议域安全依赖能回链到本册；
* 密钥与秘密材料处理不留空白；
* 安全域已接入契约目录、流程目录与验证目录；
* 滥用防护有可实施入口。
