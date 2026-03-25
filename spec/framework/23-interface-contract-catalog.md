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
* 任一跨 trust boundary 的接口都必须挂 `FLOW-ID`。
* 任一会持久化或改变权威/派生状态的写接口都必须在本目录显式登记 `Primary DATA`；若确实不落盘，也必须显式写 `none`。

## 3. Public HTTP Contracts

### 3.1 Discovery, Capabilities, and Filter Baseline

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-PUB-001` | HTTP | client | `gateway-worker` | `GET /.well-known/matrix/client` | none | `WellKnownClientResponse` | n/a | cacheable read | 404 or static JSON | `30` | `none` | `FLOW-CS-DISCOVERY` |
| `IF-PUB-002` | HTTP | remote server | `gateway-worker` | `GET /.well-known/matrix/server` | none | `WellKnownServerResponse` | n/a | cacheable read | 404 or static JSON | `32` | `none` | `FLOW-FED-DISCOVERY` |
| `IF-CS-001` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/versions` | none | `VersionsResponse` | n/a | cacheable read | 200 only | `30` | `none` | `FLOW-CS-DISCOVERY` |
| `IF-CS-002` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/capabilities` | access token | `CapabilitiesRequest` / `CapabilitiesResponse` | n/a | read-only | Matrix errcode | `30` | `none` | `FLOW-CS-DISCOVERY` |
| `IF-CS-003` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/user/{userId}/filter` | access token | `FilterUploadRequest` / `FilterUploadResponse` | canonical filter hash | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-014` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-004` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/user/{userId}/filter/{filterId}` | access token | none / `FilterDefinition` | `filter_id` | strongly consistent user read | Matrix errcode | `30` | `DATA-USER-014` | `FLOW-CS-SYNC-LONGPOLL` |

### 3.2 Identity, Session, and Sync

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-010` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/register` | registration auth | `RegisterRequest` / `LoginLikeResponse` | `client_secret` or request fingerprint | duplicate-safe create | Matrix errcode + UIA | `30` | `DATA-USER-001`,`DATA-USER-002` | `FLOW-CS-REGISTER` |
| `IF-CS-011` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/login` | login auth | `LoginRequest` / `LoginResponse` | request fingerprint | retryable before session create | Matrix errcode | `30` | `DATA-USER-001`,`DATA-USER-002` | `FLOW-CS-LOGIN` |
| `IF-CS-012` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/refresh` | refresh token | `RefreshRequest` / `RefreshResponse` | refresh token hash | linearized by `UserDO` | Matrix errcode; replay forbidden | `30` | `DATA-ID-004`,`DATA-USER-001` | `FLOW-CS-REFRESH` |
| `IF-CS-013` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/logout` + `/logout/all` | access token | `LogoutRequest` / empty JSON | session id or user scope | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-001` | `FLOW-CS-REFRESH` |
| `IF-CS-014` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/whoami` | access token | none / `WhoAmIResponse` | n/a | strongly consistent user read | Matrix errcode | `30` | `DATA-USER-001` | `FLOW-CS-LOGIN` |
| `IF-CS-015` | HTTP | client | `gateway-worker` | account data / tags / ignored users / direct rooms / read-unread markers route family | access token | `AccountDataLikeRequest` / empty or typed JSON | request fingerprint | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-006`,`DATA-USER-007`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-016` | HTTP | client | `gateway-worker` | presence route family | access token | `PresenceRequest` / `PresenceResponse` | request fingerprint | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-009`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-017` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/profile/{userId}` + `GET/PUT/DELETE /_matrix/client/*/profile/{userId}/{keyName}` | access token for write; public or access token for read per endpoint visibility | `ProfileRequest` / `ProfileResponse` | `{user_id,key_name}` + request fingerprint | strongly consistent profile write; async membership/presence propagation; eventually consistent directory projection | Matrix errcode | `30` | `DATA-USER-012`,`DATA-D1-002` | `FLOW-CS-PROFILE-PROPAGATION` |
| `IF-CS-018` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/pushrules/`, `GET /_matrix/client/*/pushrules/global/`, `GET/PUT/DELETE /_matrix/client/*/pushrules/global/{kind}/{ruleId}`, `GET/PUT /.../{ruleId}/actions`, `GET/PUT /.../{ruleId}/enabled` | access token | `PushRulesRequest` / `PushRulesResponse` | rule path + request fingerprint | linearized by `UserDO`; `before`/`after` reordering and `actions`/`enabled` subresource writes must be serialized in the same user stream; counters visible on later `/sync` | Matrix errcode | `30` | `DATA-USER-013`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-020` | HTTP | client | `gateway-worker` | `GET /_matrix/client/*/sync` | access token | `SyncRequest` / `SyncResponse` | `since` token + request params | Worker-held long poll; same token retry safe; `filter` parameter must be parsed deterministically as stored `filter_id` or inline JSON string | Matrix errcode or early return | `30` | `DATA-ID-001`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |

### 3.3 Room Mutation and Retrieval

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-030` | HTTP | client | `gateway-worker` | `POST /_matrix/client/*/createRoom` | access token | `CreateRoomRequest` / `CreateRoomResponse` | request fingerprint | serialized by creator `UserDO` then new `RoomDO` | Matrix errcode | `31` | `DATA-ROOM-001`-`008` | `FLOW-CS-ROOM-MEMBERSHIP` |
| `IF-CS-031` | HTTP | client | `gateway-worker` | `POST /join` `/leave` `/invite` `/ban` `/unban` `/kick` `/knock` route family | access token | membership request / `RoomMembershipResponse` | per-request txn context | serialized by `RoomDO` | Matrix errcode | `31` | `DATA-ROOM-001`,`DATA-ROOM-007` | `FLOW-CS-ROOM-MEMBERSHIP` |
| `IF-CS-032` | HTTP | client | `gateway-worker` | `PUT /rooms/{roomId}/send/{eventType}/{txnId}` | access token | `ClientEventContent` / `SendEventResponse` | `{user_id,device_id,room_id,txn_id}` | serialized by `RoomDO` | Matrix errcode | `31` | `DATA-ROOM-001`-`008` | `FLOW-CS-SEND-EVENT` |
| `IF-CS-033` | HTTP | client | `gateway-worker` | `PUT /rooms/{roomId}/state/{eventType}/{stateKey}` | access token | `StateEventContent` / `SendEventResponse` | request fingerprint or txn wrapper | serialized by `RoomDO` | Matrix errcode | `31` | `DATA-ROOM-001`-`008` | `FLOW-CS-SEND-EVENT` |
| `IF-CS-034` | HTTP | client | `gateway-worker` | room history family: `/messages`, `/context`, `/event`, `/state` | access token | room query / room result | cursor token | read path only | Matrix errcode | `31` | `DATA-ROOM-001`-`010` | `FLOW-CS-SEND-EVENT` |

### 3.4 Devices, E2EE, and To-Device

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-040` | HTTP | client | `gateway-worker` | device management family | access token | `DeviceRequest` / `DeviceResponse` | device id | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-002` | `FLOW-CS-LOGIN` |
| `IF-CS-041` | HTTP | client | `gateway-worker` | `PUT /sendToDevice/{eventType}/{txnId}` | access token | `SendToDeviceRequest` / empty JSON | `{sender_user_id,txn_id,event_type}` | per target user/device queue ordering | Matrix errcode | `30` | `DATA-USER-008`,`DATA-USER-010` | `FLOW-CS-SEND-TO-DEVICE` |
| `IF-CS-042` | HTTP | client | `gateway-worker` | `POST /keys/upload` | access token | `KeysUploadRequest` / `KeysUploadResponse` | device key version + fallback key id | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-043` | HTTP | client | `gateway-worker` | `POST /keys/query` | access token | `KeysQueryRequest` / `KeysQueryResponse` | request fingerprint | read-only | Matrix errcode | `30` | `DATA-USER-003`,`DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-044` | HTTP | client | `gateway-worker` | `POST /keys/claim` | access token | `KeysClaimRequest` / `KeysClaimResponse` | claim request fingerprint | per-target user serialized by `UserDO` | Matrix errcode | `30` | `DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-CS-045` | HTTP | client | `gateway-worker` | room key backup route family | access token | backup request / backup response | version id + chunk id | linearized by `UserDO` | Matrix errcode | `30` | `DATA-USER-011`,`DATA-R2-006` | `FLOW-CS-SYNC-LONGPOLL` |

### 3.5 Media and Derived Capabilities

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-CS-050` | HTTP | client | `gateway-worker` | media config + create/upload family | access token | `MediaConfigRequest` / `MediaConfigResponse` or `CreateUploadResponse` | pending upload id | create then upload ordered by upload id | Matrix errcode or 413 | `33` | `DATA-USER-015`,`DATA-R2-001`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD` |
| `IF-CS-051` | HTTP | client | `gateway-worker` | local media download + thumbnail family | access token or public per policy | media locator / stream response | n/a | read-only | Matrix errcode | `33` | `DATA-R2-001`,`DATA-R2-003`,`DATA-D1-004` | `FLOW-CS-MEDIA-DOWNLOAD` |
| `IF-CS-052` | HTTP | client | `gateway-worker` | search / user directory / public rooms / client hierarchy family | access token | query / result page | pagination token | D1 eventual consistency accepted; visibility fail-closed | Matrix errcode | `34` | `DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003` | `FLOW-SEARCH-INDEX` |

### 3.6 Federation and Application Service

| IF-ID | Type | Caller | Callee | Route / Family | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-FED-001` | HTTP | remote server | `gateway-worker` | federation version + server keys family | `X-Matrix` signature or none where spec permits | request / response JSON | n/a | cacheable read | Matrix federation error | `32` | `DATA-FED-005`,`DATA-KV-002` | `FLOW-FED-DISCOVERY` |
| `IF-FED-002` | HTTP | remote server | `gateway-worker` | `PUT /_matrix/federation/*/send/{txnId}` | `X-Matrix` signature | `FederationTransaction` / `FederationSendResult` | `{origin,txn_id}` | duplicate-safe | Matrix federation error | `32` | `DATA-FED-003`,`DATA-ROOM-001`-`010` | `FLOW-FED-INBOUND-TXN` |
| `IF-FED-003` | HTTP | remote server | `gateway-worker` | join/leave/knock handshake family | `X-Matrix` signature | template/request event / event or state | event id / txn id | serialized by `RoomDO` | Matrix federation error | `32` | `DATA-FED-004`,`DATA-ROOM-001`-`010` | `FLOW-FED-JOIN-LEAVE` |
| `IF-FED-004` | HTTP | remote server | `gateway-worker` | event/state/backfill/missing-events family | `X-Matrix` signature | room query / result | cursor or request fingerprint | read-only | Matrix federation error | `32` | `DATA-FED-004`,`DATA-ROOM-001`-`008` | `FLOW-FED-MISSING-EVENT-RECOVERY` |
| `IF-FED-005` | HTTP | remote server | `gateway-worker` | federation media family | `X-Matrix` signature or unauth per endpoint | media locator / stream | n/a | read-only | Matrix federation error | `32`,`33` | `DATA-R2-001`,`DATA-R2-002`,`DATA-R2-003` | `FLOW-CS-REMOTE-MEDIA-FETCH` |
| `IF-FED-006` | HTTP | remote server | `gateway-worker` | `GET /_matrix/federation/*/query/profile`, directory / hierarchy query family, and other explicitly registered federation queries | `X-Matrix` signature | `FederationQueryRequest` / `FederationQueryResponse` | request fingerprint | read-only; visibility fail-closed; unknown query types explicit reject | Matrix federation error | `32`,`34` | `DATA-USER-012`,`DATA-D1-003`,`DATA-ROOM-005`-`007` | `FLOW-FED-QUERY` |
| `IF-AS-001` | HTTP | appservice | `gateway-worker` | AS query endpoints family | AS token | query / response | request fingerprint | read-mostly | Matrix errcode | `34` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY` |
| `IF-AS-002` | HTTP | `jobs-worker` | appservice | HS->AS transaction family | AS token | `AppserviceTransaction` / ack | txn id | strict per appservice ordering | retryable transport error | `34` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY` |

## 4. Internal Runtime Contracts

### 4.1 Worker-to-DO

| IF-ID | Type | Caller | Callee | RPC / Method | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-INT-USER-001` | RPC | `gateway-worker` | `UserDO` | `resolveSession(accessToken)` | internal trust | `AccessTokenEnvelope` / `SessionContext` | token hash | per user serialized | typed auth error | `30` | `DATA-ID-003`,`DATA-USER-001` | `FLOW-CS-LOGIN` |
| `IF-INT-USER-002` | RPC | `gateway-worker` | `UserDO` | `collectSince(syncToken, filter)` | internal trust | `SyncCursorRequest` / `UserStreamDeltaBatch` | `{user_id,since,filter_hash}` | read-only | typed cursor error | `30` | `DATA-ID-001`,`DATA-USER-010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-INT-USER-003` | RPC | `RoomDO` | `UserDO` | `appendRoomFanout(delta)` | internal trust | `RoomFanoutDelta` / `AppendAck` | `{room_id,room_pos,user_id}` | per user serialized | retryable internal error | `30`,`31` | `DATA-USER-010` | `FLOW-ROOM-LOCAL-FANOUT` |
| `IF-INT-USER-004` | RPC | `gateway-worker` | `UserDO` | `claimOneTimeKeys(query)` | internal trust | `KeyClaimQuery` / `ClaimedKeyBatch` | request fingerprint | per user serialized | typed conflict/not-found | `30` | `DATA-USER-004`,`DATA-USER-005` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-INT-ROOM-001` | RPC | `gateway-worker` | `RoomDO` | `admitEvent(candidate)` | internal trust | `EventAdmissionRequest` / `EventAdmissionResult` | room event dedupe key | per room serialized | typed auth/state error | `31` | `DATA-ROOM-001`-`010` | `FLOW-ROOM-EVENT-ADMISSION` |
| `IF-INT-ROOM-002` | RPC | `gateway-worker` | `RoomDO` | `projectForSync(delta, filter)` | internal trust | `RoomProjectionRequest` / `RoomSyncProjection` | `{room_id,room_pos,filter_hash}` | read-only | typed projection error | `30`,`31` | `DATA-ROOM-001`-`010` | `FLOW-CS-SYNC-LONGPOLL` |
| `IF-INT-ROOM-003` | RPC | `gateway-worker` | `RoomDO` | `paginateTimeline(cursor, dir, limit)` | internal trust | `TimelineQuery` / `TimelinePage` | cursor | read-only | typed cursor error | `31` | `DATA-ROOM-001`-`006` | `FLOW-CS-SEND-EVENT` |
| `IF-INT-FED-001` | RPC | `RoomDO` / `UserDO` | `RemoteServerDO` | `enqueueOutbound(payload)` | internal trust | `OutboundTxnIntent` / `QueueAck` | `{server_name,txn_scope,event_or_edu_id}` | per server serialized | retryable internal error | `32` | `DATA-FED-001`,`DATA-FED-002` | `FLOW-FED-OUTBOUND-TXN` |
| `IF-INT-FED-002` | RPC | `gateway-worker` | `RemoteServerDO` | `recordInboundTxn(origin, txnId, summary)` | internal trust | `InboundTxnMarker` / `TxnDedupeResult` | `{origin,txn_id}` | per server serialized | typed duplicate error | `32` | `DATA-FED-003` | `FLOW-FED-INBOUND-TXN` |
| `IF-INT-MEDIA-001` | RPC | `gateway-worker` | `UserDO` | `beginMediaUpload(intent)` | internal trust | `MediaUploadIntent` / `PendingUploadGrant` | request fingerprint | per user serialized | typed quota error | `33` | `DATA-USER-015` | `FLOW-CS-MEDIA-UPLOAD` |
| `IF-INT-MEDIA-002` | RPC | `gateway-worker` | `UserDO` | `finalizeMediaUpload(result)` | internal trust | `MediaFinalizeRequest` / `MediaFinalizeAck` | pending upload id | per user serialized | typed finalize error | `33` | `DATA-USER-015`,`DATA-R2-001`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD` |

### 4.2 Worker-to-Worker, Queue, and Alarm

| IF-ID | Type | Caller | Callee | Route / Queue / Alarm | Auth | Input / Output | Idempotency | Ordering / Retry | Error Model | Owning Spec | Primary DATA | FLOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `IF-INT-WKR-001` | RPC | `gateway-worker` | `jobs-worker` | `enqueueDerivedWork()` | service binding | `DerivedWorkBatch` / `Ack` | per work item key | best effort, retryable | typed internal error | `21`,`34` | `DATA-D1-001`,`DATA-D1-002`,`DATA-D1-003` | `FLOW-SEARCH-INDEX` |
| `IF-INT-WKR-002` | RPC | `ops-worker` | `jobs-worker` | `startRebuild(jobSpec)` | service binding | `RebuildJobSpec` / `JobHandle` | operator job id | at-most-once create | typed internal error | `42` | `DATA-OPS-001`,`DATA-OPS-002` | `FLOW-REPLAY-REBUILD` |
| `IF-QUE-001` | Queue | `jobs-worker` or DO producer | `jobs-worker` | `search-index-job` | internal | `SearchIndexJob` | `event_id` | unordered, idempotent consumer | poison/retry | `34` | `DATA-D1-001` | `FLOW-SEARCH-INDEX` |
| `IF-QUE-002` | Queue | `gateway-worker` | `jobs-worker` | `media-thumbnail-job` | internal | `ThumbnailJob` | `{mxc_uri,variant}` | unordered, idempotent consumer | poison/retry | `33` | `DATA-R2-003`,`DATA-D1-004` | `FLOW-CS-MEDIA-UPLOAD` |
| `IF-QUE-003` | Queue | `jobs-worker` | `jobs-worker` | `appservice-txn-job` | internal | `AppserviceTxnJob` | `{appservice_id,txn_id}` | strict logical order per appservice | poison/retry | `34` | `DATA-D1-005` | `FLOW-AS-TXN-DELIVERY` |
| `IF-QUE-004` | Queue | `ops-worker` / `jobs-worker` | `jobs-worker` | `rebuild-shard-job` | internal | `RebuildShardJob` | `{job_id,shard_id}` | checkpointed replay order | poison/retry | `34`,`42` | `DATA-OPS-001`,`DATA-OPS-002` | `FLOW-REPLAY-REBUILD` |
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
