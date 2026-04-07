# TODO.matrix-client-server-gap-audit.md

## Purpose

本文件只记录“Matrix 官方 Client-Server `v1.17` 与本地 Spec 的残缺项 / 语义偏差补全 backlog”。

它**不是**主线交付执行清单，不能替代 [`TODO.md`](/root/Matrix/TODO.md)，也不得据此推断当前功能已实现。

## Scope

范围固定为：

* 官方来源：Matrix `v1.17` Client-Server API
* 本地对照：`spec/framework/12/23/30/31/33/34/43/44` 与相关 `DEC/OQ`
* 目标：把“缺了什么、偏了什么、该补到哪里”单独落盘，避免和当前主线实现状态混淆

## Status Legend

* `[ ]` 未补全
* `[~]` 已确认存在缺口，待 Spec/DEC/OQ/TODO 闭合
* `[x]` 已完成补全并同步回主线 Spec/测试/证据体系

## Research Baseline

* Matrix `v1.17` Client-Server API: <https://spec.matrix.org/v1.17/client-server-api/>
* 本地 Matrix 基线固定在 `v1.17`，见 [`spec/framework/12-matrix-protocol-compliance-profile.md`](/root/Matrix/spec/framework/12-matrix-protocol-compliance-profile.md)

## Confirmed Gaps

### 1. `/_matrix/client/v3/keys/changes` 仍未进入本地 contract/matrix/test/evidence 映射

- [x] `CS-GAP-001` 为 `GET /_matrix/client/v3/keys/changes` 建立本地显式覆盖。
  Official basis:
  官方 `v1.17` 当前 route 存在 `GET /_matrix/client/v3/keys/changes`，并将其定义为 initial `/sync` 之后追踪 device-list 变化的标准路径。
  Historical pre-closure status:
  本地 `spec/framework/23-interface-contract-catalog.md`、`spec/framework/12-matrix-protocol-compliance-profile.md`、`spec/framework/30-client-identity-and-sync.md` 曾没有显式 `IF/MX` route coverage；当时只有 `/sync` 中 `device_lists` 真值与 `/keys/upload|query|claim`、cross-signing、backup 路径。
  Closure delivered:
  已补齐 `MX-CS-014` / `IF-CS-048` / `30` 域正文 / `TEST-CS-003` / `EVID-CS-003` 映射，并实现 `GET /_matrix/client/v3/keys/changes`，使其基于 `/sync device_lists.changed|left` 与 `DATA-USER-010` 的 `device_state` 增量返回 `changed` / `left` 真值。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`

### 2. `m.login.application_service` 的 `v1.17` 登录/注册语义未被本地显式收敛

- [~] `CS-GAP-002` 为 application service legacy-auth compatibility 语义建立本地显式覆盖。
  Official basis:
  官方 `v1.17` 明确要求：
  1. `POST /_matrix/client/*/login` 若使用 `m.login.application_service` 且服务器不支持 Legacy authentication API，必须返回 `400 M_APPSERVICE_LOGIN_UNSUPPORTED`；
  2. `POST /_matrix/client/*/register` 仍必须支持 application service 创建用户，但在同样不支持 legacy login 时，application service 必须设置 `inhibit_login: true`，否则也必须返回 `400 M_APPSERVICE_LOGIN_UNSUPPORTED`。
  Current local status:
  本地 `12/23/30/43/44` 现已显式提到 `m.login.application_service` 仍未闭合，并把 active blocker 落入 [`OQ-0008`](/root/Matrix/spec/open-questions/OQ-0008.md)；但这仍不等于语义已实现。
  `2026-04-06` 复核后，当前 gap 已确认不是单纯缺几个 route 条目，而是缺一个可供 `gateway-worker` 在 `/login` `/register` 上使用的 appservice token validation + namespace ownership contract，同时 pinned official sources 对 invalid `as_token` 的 wire truth 也仍存在冲突。
  Required closure:
  必须显式决定 application service login/register compatibility 在本项目中的 status，并把 `/login`、`/register`、错误模型、测试和证据同步写清；不能继续依赖“没有实现所以自然不存在”的隐式状态。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  new or updated `DEC-*` / `OQ-*` if this is a product-boundary choice
  Current blocker artifact:
  [`spec/open-questions/OQ-0008.md`](/root/Matrix/spec/open-questions/OQ-0008.md)

### 3. `/_matrix/client/v3/auth/<auth type>/fallback/web` family 未被本地显式收敛

- [ ] `CS-GAP-003` 为 `GET /_matrix/client/v3/auth/<auth type>/fallback/web` family 补齐显式 disposition。
  Official basis:
  官方 `v1.17` 在 UIA / fallback 章节中明确给出 `/_matrix/client/v3/auth/<auth type>/fallback/web`，并对 `m.login.sso` 单独说明 `/_matrix/client/v3/auth/m.login.sso/fallback/web` 的行为。
  Current local status:
  本地 `MX-CS-003` / `IF-CS-059` / `OQ-0001` / `DEC-0001` 只显式覆盖 `/_matrix/client/*/login/sso/redirect*` 与 `POST /_matrix/client/v1/login/get_token`，没有把 `auth/.../fallback/web` 纳入 route family 或 stub decision。
  Required closure:
  要么把整个 fallback-web route family 明确并入现有 `MX-CS-003` / `IF-CS-059` 的 stub-only product boundary，要么另开 dedicated route family / decision；不能继续只补 `m.login.sso` 这一个具体 path，而把 generic family 留成未登记状态。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  `spec/decisions/DEC-0001.md` or new `DEC-*`
  `spec/open-questions/*.md` if decision is not yet ready

## Semantic Divergence Requiring Explicit Closure

### 4. `m.login.registration_token` 的本地语义与官方当前 registration stage 存在偏差

- [ ] `CS-GAP-004` 显式收敛 `m.login.registration_token` 偏差，而不是继续靠隐式实现约定。
  Official basis:
  官方 `v1.17` 把 `m.login.registration_token` 列为 registration authentication type，并说明它只适用于 `/register`。
  Current local status:
  本地 [`spec/framework/30-client-identity-and-sync.md`](/root/Matrix/spec/framework/30-client-identity-and-sync.md) 明确规定 `GET /register` 当前只宣告 `m.login.dummy`，而 registration token 只作为 policy enforcement 与 `GET /register/m.login.registration_token/validity` 真值的一部分，不宣告成已实现 UIA stage。
  Required closure:
  必须显式决定这是：
  1. 产品边界下的有意偏差，并以 `DEC-*` / `OQ-*` 冻结；
  2. 还是本地 spec 不完整，需要把 registration stage 模型扩成与官方一致。
  不能继续只在正文里写“当前基线只宣告 `m.login.dummy`”而没有上游偏差说明。
  Artifact targets:
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  new or updated `DEC-*` / `OQ-*`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`

## Compatibility / Legacy Audit Candidates

### 5. 旧式 fallback login web surface `/_matrix/static/client/login/` 目前未被本地明确处置

- [ ] `CS-GAP-005` 审计并显式处置 `GET /_matrix/static/client/login/`。
  Official basis:
  官方 `v1.17` 仍在 legacy login 部分给出 `GET /_matrix/static/client/login/` fallback login API。
  Current local status:
  本地 `12/23/30/43/44`、`DEC-0001`、`OQ-0001` 都未显式提及该 surface。
  Required closure:
  需要明确它在本项目中的身份是：
  1. 明确 Unsupported / Stub-Only compatibility surface；
  2. 还是无需支持但必须登记为 deterministic reject；
  3. 或者另有专门兼容策略。
  在本地未登记前，不能假设它已经被 `MX-CS-003` 或 `MX-CS-029` 自动涵盖。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  `spec/decisions/DEC-0001.md` or new `DEC-*`

### 6. `POST /createRoom` 对相同请求体复用同一 `room_id`，与“新建房间”语义冲突

- [ ] `CS-GAP-006` 显式收敛 `createRoom` 的 room identity / retry 语义。
  Official basis:
  官方 Matrix room ID 定义为 `!opaque_id:domain`，表示一个房间的唯一 opaque identity；`POST /_matrix/client/*/createRoom` 的语义是创建一个新房间，而不是把“相同请求体”隐式当成同一次幂等写。
  Current local status:
  本地 [`spec/framework/23-interface-contract-catalog.md`](/root/Matrix/spec/framework/23-interface-contract-catalog.md) 当前把 `IF-CS-030` 写成“identical request fingerprint must converge on the same derived create identity”，实现上也据此用 `request_fingerprint` 派生 `room_id`。结果是同一用户两次提交相同 createRoom body，会得到同一个 `room_id`，这会把正常的第二次建房错误折叠成第一次房间。
  Required closure:
  必须把“新建房间”与“失败后 retry-safe 恢复”拆开，显式决定：
  1. 哪种条件下允许同一 request fingerprint 收敛到既有 create attempt；
  2. 哪种条件下必须生成新的 opaque room identity。
  在 Spec/DEC/OQ 没有闭合前，不能把当前 deterministic room identity 当成符合官方语义。
  Artifact targets:
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/31-room-processing-and-room-versions.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  new or updated `DEC-*` / `OQ-*`

### 7. `/_matrix/client/versions` 只回 bare latest version，会被当前 browser SDK 误判为“不支持”

- [x] `CS-GAP-007` 为 `/versions` 的 stable compatibility ladder 建立本地显式覆盖。
  Official basis:
  官方 Matrix `/versions` contract 要求服务器报告其支持的规范版本；当前官方 `matrix-js-sdk` autodiscovery source 进一步显示，browser SDK 会对 `versions` 数组做 exact-match membership 校验，而不是把“更新的稳定版本”自动视为满足旧的最低要求。
  Historical pre-closure status:
  本地 `04.01` / `MX-CS-001` / `IF-CS-001` 曾只要求 `/_matrix/client/versions` 返回当前 pinned latest `v1.17`，测试也据此只锁定 `['v1.17']`。
  Closure delivered:
  已把 `12/23/30/43/44/TODO` 与本地/CI/staging discovery tests 改为要求稳定版本阶梯 `v1.1`~`v1.17`，并在 `gateway-worker` 中按该 ladder 响应，避免 Element Web 在 homeserver validation 阶段把 prod 误判成“不支持的旧服务器”。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  [`TODO.md`](/root/Matrix/TODO.md)

### 8. `/sync` 的 `next_batch` 被本地实现错误地硬绑定到了上一次 `filter`

- [x] `CS-GAP-008` 为 `/sync since` token 与 filter 的真实关系建立本地显式覆盖。
  Official basis:
  官方 `/sync` 将 `since` 视为前次返回的 opaque stream cursor，并把 `filter` 视为当前请求参数；上游 contract 并没有把后续请求必须沿用同一 `filter` 作为 token 有效性前置。
  Historical pre-closure status:
  本地 `collectSince()` 曾在 token 内存在 `filter_hash` 且当前请求 `filter_hash` 不同时直接返回 `400 M_INVALID_PARAM "Sync token was issued for a different filter"`；真实 Cinny browser session 因此在 initial inline filter -> stored `filter_id` 切换后进入 `Connection Lost!`。
  Closure delivered:
  已把 `12/23/30/43/44/TODO` 与本地 `/sync` 测试改为要求：`next_batch` 虽可保留 `filter_hash` 作为 opaque integrity/debug metadata，但后续增量 `/sync` 必须允许 inline JSON 与 stored `filter_id` 间切换，也必须允许改用另一个合法 filter；实现上已删除该错误的 fail-closed token/filter 绑定，并把 staging canonical suite 收紧到真实 Cinny 会触发的“initial inline filter 带 `room.timeline.limit`，后续 stored filter 只保留 `lazy_load_members`”切换路径。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  [`TODO.md`](/root/Matrix/TODO.md)

### 9. deprecated `/_matrix/media/*/config` 缺 browser CORS/preflight，会拦截 JS client 的 authenticated media config fetch

- [x] `CS-GAP-009` 为 browser-readable media compatibility surface 补齐显式 CORS contract。
  Official basis:
  官方 Matrix media config surface仍包含 `/_matrix/media/*/config` compatibility 路由；当 Web client 通过 `fetch()` 带 `Authorization` 读取该路由时，浏览器会先发 `OPTIONS` preflight，本地实现必须让该 public Matrix surface 可被浏览器读取。
  Historical pre-closure status:
  本地 CORS helper 曾只覆盖 `/.well-known` 与 `/_matrix/client/*`，没有覆盖 `/_matrix/media/*`；真实 Cinny browser session 因此在 `GET /_matrix/media/v3/config` 上被浏览器以 “No 'Access-Control-Allow-Origin' header” 拦截。
  Closure delivered:
  已把 `12/23/33/43/44/TODO` 与 local/staging/pre-release media tests 补到 browser `Origin` / `OPTIONS` contract，`gateway-worker` 现在也会对 `/_matrix/client/v1/media/config` 与 `/_matrix/media/*/config` 返回统一可读的 CORS/preflight 响应，不再让 authenticated current/compatibility config fetch 卡在浏览器层。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/33-media.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  [`TODO.md`](/root/Matrix/TODO.md)

### 10. `GET /capabilities` 若省略 `m.room_versions`，当前 browser client 会回退到 legacy room version `1`

- [x] `CS-GAP-010` 为 `m.room_versions` capability truth 建立本地显式覆盖。
  Official basis:
  官方 Matrix `v1.17` Client-Server API 在 capabilities section 明确给出 `m.room_versions`，用于告知客户端默认 room version 与可用 room version 集合。
  Historical pre-closure status:
  本地 `GET /_matrix/client/*/capabilities` 曾只返回 `m.change_password`、`m.3pid_changes`、`m.get_login_token`、`m.profile_fields`、`m.set_avatar_url`、`m.set_displayname`，没有显式暴露 `m.room_versions`。真实 browser E2E 因此在 `createRoom` 时退回到 legacy room version `1`，并收到 `400 Unsupported room version: 1`。
  Closure delivered:
  已把 `12/23/30/31/43/44`、`TODO.md`、本地 `phase-04` 测试以及 `CI + staging` dedicated canonical `TEST-CS-001` 断言同步补到 `m.room_versions.default = 12` 且 `available.{11,12} = stable`；`packages/runtime-core/src/client-domain.mjs` 现也按 room-domain truth 生成该 capability，避免 browser client 因 capability 缺失回退到不受支持的 room version。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/30-client-identity-and-sync.md`
  `spec/framework/31-room-processing-and-room-versions.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  [`TODO.md`](/root/Matrix/TODO.md)

### 11. browser-authenticated `GET /capabilities` 与 `GET /sync` 若缺显式 CORS/preflight/held-long-poll coverage，真实 Web client 会在浏览器层断连

- [x] `CS-GAP-011` 为 browser-authenticated `/capabilities` 与 `/sync` 补齐显式 CORS / preflight / long-poll closure。
  Official basis:
  官方 Matrix Web client 会以浏览器 `fetch()` 形态对 authenticated `/_matrix/client/*` 路由发起带 `Origin` 的请求；当请求带 `Authorization` 时，浏览器还会先发 `OPTIONS` preflight。对于 `/sync`，真实客户端还会走 `timeout > 0` 的 held long-poll，而不是只用 `timeout=0` 的立即返回路径。
  Historical pre-closure status:
  本地 broad CORS contract 已写成 `/_matrix/client/*` 都应可被浏览器读取，但此前显式 browser regression coverage 主要集中在 discovery/login/register 与 media config。`GET /_matrix/client/v3/capabilities` 与 `GET /_matrix/client/v3/sync` 缺少 browser-origin negative-auth 与 held-long-poll truth 的 dedicated assertions，因此真实浏览器一旦命中这些路径，仍可能表现为 `Connection Lost!`，而本地门禁继续为绿。
  Closure delivered:
  已把 local/staging regression tests 补到 browser-origin `GET/OPTIONS /capabilities` 与 `/sync` 的 authenticated / unauthenticated truth，其中 `/sync` 还显式覆盖 `timeout > 0` held long-poll 被用户流更新唤醒后的 CORS 行为；同时 `43/44` 也已把这条 `/sync` browser proof 重新接回 owning 的 `TEST-CS-002` / `EVID-CS-002` 证据线，不再只停留在 `TEST-CS-001` 的附带 coverage。
  Artifact targets:
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  `tests/local/client-identity/phase-04.test.mjs`
  `tests/local/client-identity/phase-05.test.mjs`
  `tests/staging/test-cs-002.test.mjs`
  `tests/integration/test-cs-001.test.mjs`
  `tests/staging/test-cs-001.test.mjs`

### 12. 空 `state_key` 的 room-state 路径缺少官方允许的尾斜杠兼容，真实客户端会把 `m.room.encryption` 打到 `404`

- [x] `CS-GAP-012` 为空 `state_key` room-state path 的双形态兼容补齐本地显式覆盖。
  Official basis:
  官方 Matrix Client-Server API 对 `PUT/GET /_matrix/client/v3/rooms/{roomId}/state/{eventType}/{stateKey}` 明确写明：当 `stateKey` 为空字符串时，endpoint 末尾的 `/` 是可选的，因此 `.../state/{eventType}` 与 `.../state/{eventType}/` 都必须表示同一个空 `state_key`。
  Historical pre-closure status:
  本地 `12/23/31` 之前只显式写了 `/state/{eventType}/{stateKey}` 一种形态，local/staging 回归也只覆盖不带尾斜杠的空 `state_key` 路径；`gateway-worker` 路由 matcher 因此会把真实客户端发出的 `PUT /rooms/{roomId}/state/m.room.encryption/` 误落到 `404 M_UNRECOGNIZED`。
  Closure delivered:
  已把 `MX-CS-009`、`IF-CS-033`、`IF-CS-034` 与 room query/domain 正文补到空 `state_key` 的双形态 contract，`gateway-worker` 现在也会把 `/state/{eventType}` 与 `/state/{eventType}/` 统一收敛为同一空 `state_key` 裁决；local `Phase 06` 与 staging canonical `TEST-ROOM-001` 已新增 parity regression，`TEST-CS-003` 的 `m.room.encryption` helper 也改为直接走真实客户端常见的尾斜杠路径。
  Artifact targets:
  `spec/framework/12-matrix-protocol-compliance-profile.md`
  `spec/framework/23-interface-contract-catalog.md`
  `spec/framework/31-room-processing-and-room-versions.md`
  `spec/framework/43-testing-and-compliance.md`
  `spec/framework/44-verification-and-evidence-register.md`
  `packages/testing/src/evidence.mjs`
  `tests/local/client-identity/phase-05a.test.mjs`
  `tests/local/client-identity/phase-06.test.mjs`
  `tests/local/runtime-foundations/testing-harness.test.mjs`
  `tests/staging/test-cs-003.test.mjs`
  `tests/staging/test-room-001.test.mjs`

## Execution Rule

当上述任一项真正进入主线补全时，必须在同一变更集中同步：

* owning spec
* `MX-*`
* `IF-*`
* 如需要则补 `DATA-*` / `FLOW-*` / `STATE-*`
* `TEST-*`
* `EVID-*`
* `DEC-*` / `OQ-*`
* 主线 [`TODO.md`](/root/Matrix/TODO.md)

在那之前，本文件只作为审计 backlog，不能被当作“已纳入主线闭环”的证明。
