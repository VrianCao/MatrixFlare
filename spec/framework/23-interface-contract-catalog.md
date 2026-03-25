# Interface Contract Catalog

状态：Draft-Normative
角色：接口契约总目录  
负责主文档章节：3，4，6  
扩展范围：所有外部与内部交互接口

## 1. 文档职责

* 统一登记所有外部 HTTP 接口与内部 RPC / Queue / Alarm 契约。
* 规定接口的调用方向、鉴权、幂等、重试、一致性和版本规则。
* 防止接口行为散落在不同正文中重复定义。

明确不包含：

* 不展开接口业务语义正文；
* 不存放底层数据 schema；
* 不替代测试或流程序列图。

## 2. 契约命名规则

* `Input Contract` 与 `Output Contract` 使用逻辑契约名，而不是实现语言类型名。
* 若多个 Matrix 路由版本共用完全一致的语义、鉴权、错误模型，则允许合并为一个 route family。
* `Route / Family` 必须枚举完整、可匹配的 canonical path 列表；禁止使用 `+` 拼接、相对片段或依赖读者脑补前缀的写法。
* 任一跨 trust boundary 的接口都必须挂 `FLOW-ID`。
* 任一会持久化或改变权威/派生状态的写接口都必须在本目录显式登记 `Primary DATA`；若确实不落盘，也必须显式写 `none`。

## 3. Public HTTP Contracts

### 3.1 Discovery, Capabilities, and Filter Baseline

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-PUB-001` | HTTP | client | `gateway-worker` | `GET /.well-known/matrix/client` | none | `WellKnownClientResponse` | n/a | cacheable read | 404 or static JSON | `30` | `DATA-KV-001` | `FLOW-CS-DISCOVERY` |
| `IF-PUB-002` | HTTP | remote server | `gateway-worker` | `GET /.well-known/matrix/server` | none | `WellKnownServerResponse` | n/a | cacheable read | 404 or static JSON | `32` | `none` | `FLOW-FED-DISCOVERY` |
| `IF-CS-001` | HTTP | client | `gateway-worker` | `GET /_matrix/client/versions` | none | `VersionsResponse` | n/a | cacheable read | 200 only | `30` | `none` | `FLOW-CS-DISCOVERY` |
| `IF-CS-002` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/capabilities` | access token | `CapabilitiesRequest` / `CapabilitiesResponse` | n/a | read-only | Matrix errcode | `30` | `none` | `FLOW-CS-DISCOVERY` |
| `IF-CS-003` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/user/{userId}/filter` | access token | `FilterUploadRequest` / `FilterUploadResponse` | canonical filter hash | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-014` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-004` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/user/{userId}/filter/{filterId}` | access token | none / `FilterDefinition` | `filter_id` | strongly consistent user read | Matrix errcode | `30` | `DATA-USER-014` | `FLOW-CS-SYNC-LONGPOLL` |

### 3.2 Identity, Session, and Sync

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-010` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/register` | registration auth | `RegisterRequest` / `LoginLikeResponse` | `client_secret` or request fingerprint | duplicate-safe create | Matrix errcode + UIA | `30` | `DATA-USER-001`,`DATA-USER-002` | `FLOW-CS-REGISTER` |
| `IF-CS-011` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/login` | login auth | `LoginRequest` / `LoginResponse` | request fingerprint | retryable before session create | Matrix errcode | `30` | `DATA-USER-001`,`DATA-USER-002` | `FLOW-CS-LOGIN` |
| `IF-CS-012` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/refresh` | refresh token | `RefreshRequest` / `RefreshResponse` | refresh token hash | linearized by `UserDO` | Matrix errcode; replay forbidden | `30` | `DATA-ID-004`,`DATA-USER-001` | `FLOW-CS-REFRESH` |
| `IF-CS-013` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/logout`, `POST /_matrix/client/*/logout/all` | access token | `LogoutRequest` / empty JSON | session id or user scope | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-001` | `FLOW-CS-REFRESH` |
| `IF-CS-014` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/account/whoami` | access token | none / `WhoAmIResponse` | n/a | strongly consistent user read | Matrix errcode | `30` | `DATA-USER-001` | `FLOW-CS-LOGIN` |
| `IF-CS-015` | HTTP | client | `gateway-worker` | `GET/PUT /_matrix/client/*/user/{userId}/account_data/{type}`, `GET/PUT /_matrix/client/*/user/{userId}/rooms/{roomId}/account_data/{type}`, `GET /_matrix/client/*/user/{userId}/rooms/{roomId}/tags`, `PUT/DELETE /_matrix/client/*/user/{userId}/rooms/{roomId}/tags/{tag}`, `POST /_matrix/client/*/rooms/{roomId}/read_markers` | access token | `AccountDataLikeRequest` / empty or typed JSON | request fingerprint | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-006`,`DATA-USER-007`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-016` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/presence/{userId}/status`, `PUT /_matrix/client/*/presence/{userId}/status` | access token | `PresenceRequest` / `PresenceResponse` | request fingerprint | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-009`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-017` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/profile/{userId}` + `GET/PUT/DELETE /_matrix/client/*/profile/{userId}/{keyName}` | access token for write; public or access token for read per endpoint visibility | `ProfileRequest` / `ProfileResponse` | `{user_id,key_name}` + request fingerprint | strongly consistent profile write; async membership/presence propagation; eventually consistent directory projection | Matrix errcode | `30` | `DATA-USER-012`,`DATA-D1-002` | `FLOW-CS-PROFILE-PROPAGATION` |
| `IF-CS-018` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/pushrules/`, `GET /_matrix/client/*/pushrules/global/`, `GET/PUT/DELETE /_matrix/client/*/pushrules/global/{kind}/{ruleId}`, `GET/PUT /.../{ruleId}/actions`, `GET/PUT /.../{ruleId}/enabled` | access token | `PushRulesRequest` / `PushRulesResponse` | rule path + request fingerprint | linearized by `UserDO`; `before`/`after` reordering and `actions`/`enabled` subresource writes must be serialized in the same user stream; counters visible on later `/sync` | Matrix errcode | `30` | `DATA-USER-013`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-019` | HTTP | client | `gateway-worker` | `PUT /_matrix/client/*/rooms/{roomId}/typing/{userId}`, `POST /_matrix/client/*/rooms/{roomId}/receipt/{receiptType}/{eventId}` | access token | `EphemeralRoomWriteRequest` / empty JSON | request fingerprint | serialized by `RoomDO`; response visibility realized through later `/sync` | Matrix errcode | `30`,`31` | `DATA-ROOM-009`,`DATA-ROOM-010`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-020` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/sync` | access token | `SyncRequest` / `SyncResponse` | `since` token + request params | Worker-held long poll; same token retry safe; `filter` parameter must be parsed deterministically as stored `filter_id` or inline JSON string | Matrix errcode or early return | `30` | `DATA-ID-001`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |

### 3.3 Room Mutation and Retrieval

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-030` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/createRoom` | access token | `CreateRoomRequest` / `CreateRoomResponse` | request fingerprint | serialized by creator `UserDO` then new `RoomDO` | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` | `FLOW-CS-ROOM-MEMBERSHIP` |
| `IF-CS-031` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/join/{roomIdOrAlias}`, `POST /_matrix/client/*/rooms/{roomId}/join`, `POST /_matrix/client/*/rooms/{roomId}/leave`, `POST /_matrix/client/*/rooms/{roomId}/invite`, `POST /_matrix/client/*/rooms/{roomId}/ban`, `POST /_matrix/client/*/rooms/{roomId}/unban`, `POST /_matrix/client/*/rooms/{roomId}/kick`, `POST /_matrix/client/*/knock/{roomIdOrAlias}`, `POST /_matrix/client/*/rooms/{roomId}/forget` | access token | membership request / `RoomMembershipResponse` | per-request txn context | serialized by `RoomDO` | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-007` | `FLOW-CS-ROOM-MEMBERSHIP` |
| `IF-CS-032` | HTTP | client | `gateway-worker` | `PUT /_matrix/client/*/rooms/{roomId}/send/{eventType}/{txnId}` | access token | `ClientEventContent` / `SendEventResponse` | `{user_id,device_id,room_id,route_template,txn_id}` | serialized by `RoomDO`; same txn key + same request hash must return same result, different hash must conflict | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-011`,`DATA-ROOM-012` | `FLOW-CS-SEND-EVENT` |
| `IF-CS-033` | HTTP | client | `gateway-worker` | `PUT /_matrix/client/*/rooms/{roomId}/state/{eventType}/{stateKey}` | access token | `StateEventContent` / `SendEventResponse` | `{user_id,device_id,room_id,route_template,txn_id_or_request_hash}` | serialized by `RoomDO`; same dedupe key + same request hash must return same result, different hash must conflict | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-011`,`DATA-ROOM-012` | `FLOW-CS-SEND-EVENT` |
| `IF-CS-034` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/rooms/{roomId}/messages`, `GET /_matrix/client/*/rooms/{roomId}/context/{eventId}`, `GET /_matrix/client/*/rooms/{roomId}/event/{eventId}`, `GET /_matrix/client/*/rooms/{roomId}/state`, `GET /_matrix/client/*/rooms/{roomId}/state/{eventType}/{stateKey}`, `GET /_matrix/client/*/rooms/{roomId}/members`, `GET /_matrix/client/*/rooms/{roomId}/joined_members`, `GET /_matrix/client/*/rooms/{roomId}/relations/{eventId}`, `GET /_matrix/client/*/rooms/{roomId}/relations/{eventId}/{relType}`, `GET /_matrix/client/*/rooms/{roomId}/relations/{eventId}/{relType}/{eventType}`, `GET /_matrix/client/*/rooms/{roomId}/threads`, `GET /_matrix/client/*/rooms/{roomId}/timestamp_to_event` | access token | room query / room result | cursor token | read path only | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` | `FLOW-CS-ROOM-QUERY` |
| `IF-CS-035` | HTTP | client | `gateway-worker` | `PUT /_matrix/client/*/rooms/{roomId}/redact/{eventId}/{txnId}` | access token | `RedactionRequest` / `SendEventResponse` | `{user_id,device_id,room_id,route_template,txn_id}` | serialized by `RoomDO`; same txn key + same request hash must return same result, different hash must conflict | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-011`,`DATA-ROOM-012` | `FLOW-CS-SEND-EVENT` |

### 3.4 Devices, E2EE, and To-Device

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-040` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/devices`, `GET /_matrix/client/*/devices/{deviceId}`, `PUT /_matrix/client/*/devices/{deviceId}`, `DELETE /_matrix/client/*/devices/{deviceId}`, `POST /_matrix/client/*/delete_devices` | access token | `DeviceRequest` / `DeviceResponse` | device id | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-002` | `FLOW-CS-LOGIN` |
| `IF-CS-041` | HTTP | client | `gateway-worker` | `PUT /_matrix/client/*/sendToDevice/{eventType}/{txnId}` | access token | `SendToDeviceRequest` / empty JSON | `{sender_user_id,event_type,txn_id}` | per target user/device queue ordering; same txn key + same request hash must return same result, different hash must conflict | Matrix errcode | `30` | `DATA-USER-008`,`DATA-USER-010`,`DATA-USER-016` | `FLOW-CS-SEND-TO-DEVICE` |
| `IF-CS-042` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/keys/upload` | access token | `KeysUploadRequest` / `KeysUploadResponse` | device key version + fallback key id | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-043` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/keys/query` | access token | `KeysQueryRequest` / `KeysQueryResponse` | request fingerprint | read-only | Matrix errcode | `30` | `DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-044` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/keys/claim` | access token | `KeysClaimRequest` / `KeysClaimResponse` | claim request fingerprint | per-target user serialized by `UserDO` | Matrix errcode | `30` | `DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-045` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/room_keys/version`, `GET /_matrix/client/*/room_keys/version`, `GET/PUT/DELETE /_matrix/client/*/room_keys/version/{version}`, `GET/PUT /_matrix/client/*/room_keys/keys`, `GET/PUT/DELETE /_matrix/client/*/room_keys/keys/{roomId}`, `GET/PUT/DELETE /_matrix/client/*/room_keys/keys/{roomId}/{sessionId}` | access token | backup request / backup response | version id + chunk id | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-011`,`DATA-R2-006` | `FLOW-CS-SYNC-LONGPOLL` |

### 3.5 Media and Derived Capabilities

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-050` | HTTP | client | `gateway-worker` | `GET /_matrix/media/*/config`, `POST /_matrix/media/*/create`, `POST /_matrix/media/*/upload`, `PUT /_matrix/media/*/upload/{serverName}/{mediaId}` | access token | `MediaConfigRequest` / `MediaConfigResponse` or `CreateUploadResponse` | pending upload id | create then upload ordered by upload id | Matrix errcode or 413 | `33` | `DATA-USER-015`,`DATA-R2-001`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD` |
| `IF-CS-051` | HTTP | client | `gateway-worker` | `GET /_matrix/media/*/download/{serverName}/{mediaId}`, `GET /_matrix/media/*/download/{serverName}/{mediaId}/{fileName}`, `GET /_matrix/media/*/thumbnail/{serverName}/{mediaId}` | access token or public per policy | media locator / stream response | n/a | read-only | Matrix errcode | `33` | `DATA-R2-001`,`DATA-R2-003`,`DATA-D1-004` | `FLOW-CS-MEDIA-DOWNLOAD` |
| `IF-CS-052` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/search`, `POST /_matrix/client/*/user_directory/search`, `GET/POST /_matrix/client/*/publicRooms`, `GET /_matrix/client/*/rooms/{roomId}/hierarchy` | access token | query / result page | pagination token | D1 eventual consistency accepted; visibility fail-closed | Matrix errcode | `34` | `DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003` | `FLOW-SEARCH-INDEX` |

### 3.6 Federation and Application Service

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-FED-001` | HTTP | remote server | `gateway-worker` | `GET /_matrix/federation/*/version`, `GET /_matrix/key/*/server`, `GET /_matrix/key/*/server/{keyId}`, `POST /_matrix/key/*/query` | `X-Matrix` signature or none where spec permits | request / response JSON | n/a | cacheable read | Matrix federation error | `32` | `DATA-FED-005`,`DATA-KV-002` | `FLOW-FED-DISCOVERY` |
| `IF-FED-002` | HTTP | remote server | `gateway-worker` | `PUT /_matrix/federation/*/send/{txnId}` | `X-Matrix` signature | `FederationTransaction` / `FederationSendResult` | `{origin,txn_id}` | duplicate-safe; same txn key must short-circuit to cached result | Matrix federation error | `32` | `DATA-FED-003`,`DATA-FED-006`,`DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` | `FLOW-FED-INBOUND-TXN` |
| `IF-FED-003` | HTTP | remote server | `gateway-worker` | `GET /_matrix/federation/*/make_join/{roomId}/{userId}`, `PUT /_matrix/federation/*/send_join/{roomId}/{eventId}`, `GET /_matrix/federation/*/make_leave/{roomId}/{userId}`, `PUT /_matrix/federation/*/send_leave/{roomId}/{eventId}`, `PUT /_matrix/federation/*/invite/{roomId}/{eventId}`, `GET /_matrix/federation/*/make_knock/{roomId}/{userId}`, `PUT /_matrix/federation/*/send_knock/{roomId}/{eventId}` | `X-Matrix` signature | template/request event / event or state | event id / txn id | serialized by `RoomDO` | Matrix federation error | `32` | `DATA-FED-004`,`DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` | `FLOW-FED-JOIN-LEAVE` |
| `IF-FED-004` | HTTP | remote server | `gateway-worker` | `GET /_matrix/federation/*/event/{eventId}`, `GET /_matrix/federation/*/state/{roomId}`, `GET /_matrix/federation/*/state_ids/{roomId}`, `GET /_matrix/federation/*/backfill/{roomId}`, `POST /_matrix/federation/*/get_missing_events/{roomId}` | `X-Matrix` signature | room query / result | cursor or request fingerprint | read-only | Matrix federation error | `32` | `DATA-FED-004`,`DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008` | `FLOW-FED-MISSING-EVENT-RECOVERY` |
| `IF-FED-005` | HTTP | remote server | `gateway-worker` | `GET /_matrix/media/*/download/{serverName}/{mediaId}`, `GET /_matrix/media/*/download/{serverName}/{mediaId}/{fileName}`, `GET /_matrix/media/*/thumbnail/{serverName}/{mediaId}` | `X-Matrix` signature or unauth per endpoint | media locator / stream | n/a | read-only | Matrix federation error | `32`,`33` | `DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003` | `FLOW-CS-REMOTE-MEDIA-FETCH` |
| `IF-FED-006` | HTTP | remote server | `gateway-worker` | `GET /_matrix/federation/*/query/profile`, directory / hierarchy query family, and other explicitly registered federation queries | `X-Matrix` signature | `FederationQueryRequest` / `FederationQueryResponse` | request fingerprint | read-only; visibility fail-closed; unknown query types explicit reject | Matrix federation error | `32`,`34` | `DATA-USER-012`,`DATA-D1-003`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007` | `FLOW-FED-QUERY` |
| `IF-AS-001` | HTTP | appservice | `gateway-worker` | `GET /_matrix/app/*/users/{userId}`, `GET /_matrix/app/*/rooms/{roomAlias}`, `POST /_matrix/app/*/ping`, `GET /_matrix/app/*/thirdparty/protocols`, `GET /_matrix/app/*/thirdparty/protocol/{protocol}`, `GET /_matrix/app/*/thirdparty/location/{protocol}`, `GET /_matrix/app/*/thirdparty/user/{protocol}` | AS token | query / response | request fingerprint | read-mostly | Matrix errcode | `34` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY` |
| `IF-AS-002` | HTTP | `jobs-worker` | appservice | HS->AS transaction family | AS token | `AppserviceTransaction` / ack | txn id | strict per appservice ordering | retryable transport error | `34` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY` |

### 3.7 Administrative Control Plane

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-OPS-001` | HTTP | operator / automation | `ops-worker` | `GET /_ops/v1/healthz`, `GET /_ops/v1/readyz` | Cloudflare Access JWT | none / `OpsHealthResponse` | n/a | read-only | typed ops error | `40`,`42` | `none` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-002` | HTTP | operator / automation | `ops-worker` | `POST /_ops/v1/exports` | Cloudflare Access JWT | `ExportJobRequest` / `JobHandle` | `{operator_principal_id,idempotency_key,target_scope,request_fingerprint}` | duplicate-safe create | typed ops error; 401/403/409/422 | `42`,`40` | `DATA-OPS-001`,`DATA-OPS-004`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-003` | HTTP | operator / automation | `ops-worker` | `POST /_ops/v1/restores` | Cloudflare Access JWT | `RestoreJobRequest` / `JobHandle` | `{operator_principal_id,idempotency_key,target_scope,request_fingerprint}` | duplicate-safe create | typed ops error; 401/403/409/422 | `42`,`40` | `DATA-OPS-001`,`DATA-OPS-004`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-004` | HTTP | operator / automation | `ops-worker` | `POST /_ops/v1/rebuilds` | Cloudflare Access JWT | `RebuildJobRequest` / `JobHandle` | `{operator_principal_id,idempotency_key,target_scope,request_fingerprint}` | duplicate-safe create | typed ops error; 401/403/409/422 | `42`,`40` | `DATA-OPS-001`,`DATA-OPS-002`,`DATA-OPS-004` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-005` | HTTP | operator / automation | `ops-worker` | `POST /_ops/v1/repairs` | Cloudflare Access JWT | `RepairJobRequest` / `JobHandle` | `{operator_principal_id,idempotency_key,target_scope,request_fingerprint}` | duplicate-safe create | typed ops error; 401/403/409/422 | `42`,`40` | `DATA-OPS-001`,`DATA-OPS-003`,`DATA-OPS-004` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-006` | HTTP | operator / automation | `ops-worker` | `GET /_ops/v1/jobs/{jobId}`, `GET /_ops/v1/jobs?type=&state=&scope=` | Cloudflare Access JWT | `JobStatusQuery` / `JobStatusResponse` | `job_id` or normalized query | read-only | typed ops error; 401/403/404 | `42`,`40` | `DATA-OPS-001`,`DATA-OPS-002`,`DATA-OPS-004` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-007` | HTTP | operator / automation | `ops-worker` | `POST /_ops/v1/jobs/{jobId}/cancel` | Cloudflare Access JWT | `JobCancelRequest` / `JobCancelResponse` | `{operator_principal_id,idempotency_key,job_id}` | linearized by `job_id` | typed ops error; 401/403/404/409 | `42`,`40` | `DATA-OPS-001`,`DATA-OPS-002`,`DATA-OPS-004` | `FLOW-OPS-JOB-CONTROL` |
| `IF-OPS-008` | HTTP | operator / automation | `ops-worker` | `GET/POST /_ops/v1/appservices`, `GET/PUT/DELETE /_ops/v1/appservices/{appserviceId}` | Cloudflare Access JWT | `AppserviceConfigRequest` / `AppserviceConfigResponse` | `{operator_principal_id,idempotency_key,appservice_id}` | linearized by `appservice_id` | typed ops error; 401/403/404/409/422 | `34`,`40`,`42` | `DATA-D1-005`,`DATA-OPS-004` | `FLOW-OPS-JOB-CONTROL` |

## 4. Internal Runtime Contracts

### 4.1 Worker-to-DO

| IF-ID | Type | Caller | Callee | RPC / Method | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-INT-USER-001` | RPC | `gateway-worker` | `UserDO` | `resolveSession(accessToken)` | internal trust | `AccessTokenEnvelope` / `SessionContext` | token hash | per user serialized | typed auth error | `30` | `DATA-ID-003`,`DATA-USER-001` | `FLOW-CS-LOGIN` |
| `IF-INT-USER-002` | RPC | `gateway-worker` | `UserDO` | `collectSince(syncToken, filter)` | internal trust | `SyncCursorRequest` / `UserStreamDeltaBatch` | `{user_id,session_id,since,filter_hash,full_state,use_state_after}` | read-only | typed cursor error | `30` | `DATA-ID-001`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-INT-USER-003` | RPC | `RoomDO` | `UserDO` | `appendRoomFanout(delta)` | internal trust | `RoomFanoutDelta` / `AppendAck` | `{room_id,room_pos,user_id}` | per user serialized; at-least-once until durable append ack; ack must be durable before outbox GC | retryable internal error | `30`,`31` | `DATA-ROOM-011`,`DATA-USER-010` | `FLOW-ROOM-LOCAL-FANOUT` |
| `IF-INT-USER-004` | RPC | `gateway-worker` | `UserDO` | `claimOneTimeKeys(query)` | internal trust | `KeyClaimQuery` / `ClaimedKeyBatch` | request fingerprint | per user serialized | typed conflict/not-found | `30` | `DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-INT-USER-005` | RPC | `gateway-worker` | `UserDO` | `enqueueToDevice(batch)` | internal trust | `ToDeviceEnqueueRequest` / `AppendAck` | `{sender_user_id,txn_id,event_type,target_user_id,target_device_id}` | per target user serialized | typed delivery error | `30` | `DATA-USER-008`,`DATA-USER-010` | `FLOW-CS-SEND-TO-DEVICE` |
| `IF-INT-USER-006` | RPC | `jobs-worker` | `UserDO` | `exportShard(exportSpec)` | internal trust | `UserExportSpec` / `ExportShardAck` | `{job_id,user_id_or_shard}` | checkpointed replay order | typed internal error | `42` | `DATA-USER-001`,`DATA-USER-002`,`DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005`,`DATA-USER-006`,`DATA-USER-007`,`DATA-USER-008`,`DATA-USER-009`,`DATA-USER-010`,`DATA-USER-011`,`DATA-USER-012`,`DATA-USER-013`,`DATA-USER-014`,`DATA-USER-015`,`DATA-USER-016`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-INT-ROOM-001` | RPC | `gateway-worker` | `RoomDO` | `admitEvent(candidate)` | internal trust | `EventAdmissionRequest` / `EventAdmissionResult` | room event dedupe key | per room serialized | typed auth/state error | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010`,`DATA-ROOM-011`,`DATA-ROOM-012` | `FLOW-ROOM-EVENT-ADMISSION` |
| `IF-INT-ROOM-002` | RPC | `gateway-worker` | `RoomDO` | `projectForSync(delta, filter)` | internal trust | `RoomProjectionRequest` / `RoomSyncProjection` | `{room_id,room_pos,filter_hash}` | read-only | typed projection error | `30`,`31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-INT-ROOM-003` | RPC | `gateway-worker` | `RoomDO` | `paginateTimeline(cursor, dir, limit)` | internal trust | `TimelineQuery` / `TimelinePage` | cursor | read-only | typed cursor error | `31` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006` | `FLOW-CS-ROOM-QUERY` |
| `IF-INT-ROOM-004` | RPC | `jobs-worker` | `RoomDO` | `exportShard(exportSpec)` | internal trust | `RoomExportSpec` / `ExportShardAck` | `{job_id,room_id_or_shard}` | checkpointed replay order | typed internal error | `42` | `DATA-ROOM-001`,`DATA-ROOM-002`,`DATA-ROOM-003`,`DATA-ROOM-004`,`DATA-ROOM-005`,`DATA-ROOM-006`,`DATA-ROOM-007`,`DATA-ROOM-008`,`DATA-ROOM-009`,`DATA-ROOM-010`,`DATA-ROOM-011`,`DATA-ROOM-012`,`DATA-R2-004`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-INT-FED-001` | RPC | `RoomDO` / `UserDO` | `RemoteServerDO` | `enqueueOutbound(payload)` | internal trust | `OutboundTxnIntent` / `QueueAck` | `{server_name,txn_scope,event_or_edu_id}` | per server serialized | retryable internal error | `32` | `DATA-FED-001`,`DATA-FED-002` | `FLOW-FED-OUTBOUND-TXN` |
| `IF-INT-FED-002` | RPC | `gateway-worker` | `RemoteServerDO` | `recordInboundTxn(origin, txnId, summary)` | internal trust | `InboundTxnMarker` / `TxnDedupeResult` | `{origin,txn_id}` | per server serialized | typed duplicate error | `32` | `DATA-FED-003`,`DATA-FED-006` | `FLOW-FED-INBOUND-TXN` |
| `IF-INT-FED-003` | RPC | `jobs-worker` | `RemoteServerDO` | `exportShard(exportSpec)` | internal trust | `RemoteQueueExportSpec` / `ExportShardAck` | `{job_id,server_name_or_shard}` | checkpointed replay order | typed internal error | `42` | `DATA-FED-001`,`DATA-FED-002`,`DATA-FED-003`,`DATA-FED-004`,`DATA-FED-005`,`DATA-FED-006`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-INT-MEDIA-001` | RPC | `gateway-worker` | `UserDO` | `beginMediaUpload(intent)` | internal trust | `MediaUploadIntent` / `PendingUploadGrant` | request fingerprint | per user serialized | typed quota error | `33` | `DATA-USER-015` | `FLOW-CS-MEDIA-UPLOAD` |
| `IF-INT-MEDIA-002` | RPC | `gateway-worker` | `UserDO` | `finalizeMediaUpload(result)` | internal trust | `MediaFinalizeRequest` / `MediaFinalizeAck` | pending upload id | per user serialized | typed finalize error | `33` | `DATA-USER-015`,`DATA-R2-001`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD` |

### 4.2 Worker-to-Worker, Queue, and Alarm

| IF-ID | Type | Caller | Callee | Route / Queue / Alarm | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-INT-WKR-001` | RPC | `gateway-worker` | `jobs-worker` | `enqueueDerivedWork()` | service binding | `DerivedWorkBatch` / `Ack` | per work item key | best effort, retryable | typed internal error | `21`,`34` | `DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003` | `FLOW-SEARCH-INDEX` |
| `IF-INT-WKR-002` | RPC | `ops-worker` | `jobs-worker` | `startRebuild(jobSpec)` | service binding | `RebuildJobSpec` / `JobHandle` | operator job id | at-most-once create | typed internal error | `42` | `DATA-OPS-001`,`DATA-OPS-002` | `FLOW-REPLAY-REBUILD` |
| `IF-INT-WKR-003` | RPC | `ops-worker` | `jobs-worker` | `startExport(jobSpec)` | service binding | `ExportJobSpec` / `JobHandle` | operator job id | at-most-once create | typed internal error | `42` | `DATA-OPS-001`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-INT-WKR-004` | RPC | `ops-worker` | `jobs-worker` | `startRestore(jobSpec)` | service binding | `RestoreJobSpec` / `JobHandle` | operator job id | at-most-once create | typed internal error | `42` | `DATA-OPS-001`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-INT-WKR-005` | RPC | `ops-worker` | `jobs-worker` | `startRepair(jobSpec)` | service binding | `RepairJobSpec` / `JobHandle` | operator job id | at-most-once create | typed internal error | `42` | `DATA-OPS-001`,`DATA-OPS-003` | `FLOW-OPS-JOB-CONTROL` |
| `IF-QUE-001` | Queue | `jobs-worker` or DO producer | `jobs-worker` | `search-index-job` | internal | `SearchIndexJob` | `event_id` | unordered, idempotent consumer | poison/retry | `34` | `DATA-D1-001` | `FLOW-SEARCH-INDEX` |
| `IF-QUE-002` | Queue | `gateway-worker` | `jobs-worker` | `media-thumbnail-job` | internal | `ThumbnailJob` | `{mxc_uri,variant}` | unordered, idempotent consumer | poison/retry | `33` | `DATA-R2-003`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD` |
| `IF-QUE-003` | Queue | `jobs-worker` | `jobs-worker` | `appservice-txn-job` | internal | `AppserviceTxnJob` | `{appservice_id,txn_id}` | strict logical order per appservice | poison/retry | `34` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY` |
| `IF-QUE-004` | Queue | `ops-worker` / `jobs-worker` | `jobs-worker` | `rebuild-shard-job` | internal | `RebuildShardJob` | `{job_id,shard_id}` | checkpointed replay order | poison/retry | `34`,`42` | `DATA-OPS-001`,`DATA-OPS-002` | `FLOW-REPLAY-REBUILD` |
| `IF-QUE-005` | Queue | `ops-worker` / `jobs-worker` | `jobs-worker` | `export-shard-job` | internal | `ExportShardJob` | `{job_id,shard_kind,shard_id}` | checkpointed replay order | poison/retry | `42` | `DATA-OPS-001`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-QUE-006` | Queue | `ops-worker` / `jobs-worker` | `jobs-worker` | `restore-shard-job` | internal | `RestoreShardJob` | `{job_id,shard_kind,shard_id}` | checkpointed replay order | poison/retry | `42` | `DATA-OPS-001`,`DATA-R2-005` | `FLOW-OPS-JOB-CONTROL` |
| `IF-QUE-007` | Queue | `ops-worker` / `jobs-worker` | `jobs-worker` | `repair-shard-job` | internal | `RepairShardJob` | `{job_id,scope_kind,scope_id}` | checkpointed replay order | poison/retry | `42` | `DATA-OPS-001`,`DATA-OPS-003` | `FLOW-OPS-JOB-CONTROL` |
| `IF-ALARM-001` | Alarm | runtime | `RemoteServerDO` | `retryOutboundAlarm()` | DO internal | none / internal | alarm slot | per server serialized | internal retry | `32` | `DATA-FED-001`,`DATA-FED-002` | `FLOW-FED-OUTBOUND-TXN` |
| `IF-ALARM-002` | Alarm | runtime | `RoomDO` | `expireTypingAlarm()` | DO internal | none / internal | room alarm slot | per room serialized | internal retry | `31` | `DATA-ROOM-010` | `FLOW-ROOM-LOCAL-FANOUT` |
| `IF-ALARM-003` | Alarm | runtime | rebuild coordinator | `continueRebuildAlarm()` | DO internal | none / internal | job alarm slot | serialized by job | internal retry | `42` | `DATA-OPS-001`,`DATA-OPS-002` | `FLOW-REPLAY-REBUILD` |

## 5. 版本与兼容规则

* 任何 `IF-INT-*` 变更都必须满足 `REQ-ARCH-017` 的前后兼容要求。
* Worker 与 DO 之间禁止传递位置敏感的 tuple；必须使用命名字段，以降低版本偏斜风险。
* Queue 负载一经入队，不允许就地改写；新版本消费者必须兼容旧负载。

## 6. 完成标准

* 所有关键外部与内部接口均已登记；
* 鉴权、幂等、顺序、重试规则都已显式定义；
* 接口不再散落在不同正文中重复定义；
* 开发团队可据此生成 handler、RPC、queue consumer 骨架。
