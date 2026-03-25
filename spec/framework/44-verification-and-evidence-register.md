# Verification and Evidence Register

状态：Draft-Normative
角色：验证证据分册
负责主文档章节：7
扩展范围：全部 requirement / contract / constraint 的验证闭环

## 1. 文档职责

* 统一登记测试证据与发布门禁证据。
* 把“通过了什么、如何证明、证据存在哪里”从测试策略中分离出来。
* 为“文档即真相”补齐可验证性闭环。

## 2. Artifact Convention

### 2.1 证据位置约定

证据工件路径必须遵循：

* `evidence/<scope>/<EVID-ID>/<run_ts>/summary.md`
* `evidence/<scope>/<EVID-ID>/<run_ts>/artifacts/...`

其中 `<scope>` 只允许 `L1`、`L2`、`L3` 或 `common`。

若工件体积过大，可放在外部对象存储，但必须在 `summary.md` 中保留不可变引用。

### 2.2 结果状态

* `pass`
* `fail`
* `waived`
* `superseded`

失败证据不得删除，只能被后续证据 supersede。

### 2.3 `Source IDs` 语法规则

* `Source IDs` 默认使用逗号分隔的 canonical ID 列表。
* 区间写法例如 ``REQ-OPS-010`-`012`` 一律禁止；进入仓库前必须展开为显式枚举。
* 前缀通配仅允许使用末尾 `*` 形式，例如 `REQ-SEC-*`、`CF-*`；其规范含义是“匹配当前仓库中该前缀下的全部已登记 canonical IDs”。
* 任何包含通配的证据项，都必须在对应 `summary.md` 或并列机器工件中输出“本次运行实际展开后的完整 ID 清单”，作为审计快照。
* CI traceability 工具必须先展开通配，再做闭环校验；不得把未展开表达式直接当作已验证结果。

## 3. Evidence Catalog

| EVID-ID | Source IDs | Evidence Type | Generation Method | Environment | Frequency | Pass Criteria | Artifact Location | Retention | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `EVID-GOV-001` | `REQ-*`,`MX-*`,`CF-*`,`IF-*`,`DATA-*`,`FLOW-*`,`STATE-*`,`TEST-*`,`EVID-*` | governance | CI traceability report | CI | per commit | ID 链接完整、无断链、无未登记引用、无 compatibility page 被当作权威正文引用 | `evidence/common/EVID-GOV-001/` | release lifetime | architecture |
| `EVID-CS-001` | `MX-CS-001`,`MX-CS-002`,`MX-CS-006`,`MX-CS-019` | integration/protocol | client-core CI + staging report | CI + staging | per release candidate | discovery/capabilities/session/profile 核心用例与 profile propagation 基线全通过 | `evidence/L1/EVID-CS-001/` | release lifetime | client protocol |
| `EVID-CS-002` | `MX-CS-004`,`MX-CS-006`,`MX-CS-007`,`MX-CS-010`,`MX-CS-015` | protocol | `/sync` conformance report | staging | per release candidate | filter lifecycle、`include_leave`、lazy-load members、initial/incremental/limited/`full_state`/`use_state_after`、push rules 与 notification counts 全通过 | `evidence/L1/EVID-CS-002/` | release lifetime | client protocol |
| `EVID-CS-003` | `MX-CS-013`,`MX-CS-014` | protocol | devices/E2EE transport report | staging | per release candidate | key claim at-most-once 与 device-list 增量通过 | `evidence/L1/EVID-CS-003/` | release lifetime | client protocol |
| `EVID-ROOM-001` | `MX-CS-008`,`MX-CS-009`,`MX-CS-010` | property/integration | room-core report | CI + staging | per release candidate | 本地房间行为和 fanout 全通过 | `evidence/L1/EVID-ROOM-001/` | release lifetime | room core |
| `EVID-ROOM-002` | `MX-RV-011`,`MX-RV-012` | protocol/property | room-version report | CI + staging | per release candidate | `L1` 时 room version `12` 行为通过；`L2-L3` 时 room version `11/12` 差异行为通过 | `evidence/L1/EVID-ROOM-002/` | release lifetime | room core |
| `EVID-FED-001` | `MX-FED-001`,`MX-FED-002`,`MX-FED-003`,`MX-FED-005`,`MX-FED-006`,`MX-FED-007` | federation | federation-core report | staging | per release candidate | 发现、验签、事务、握手，以及 query-surface auth/routing 全部通过 | `evidence/L2/EVID-FED-001/` | release lifetime | federation |
| `EVID-FED-002` | `MX-FED-004` | chaos/recovery | federation recovery report | pre-release | per release candidate | gap repair / backfill 场景通过 | `evidence/L2/EVID-FED-002/` | release lifetime | federation |
| `EVID-MEDIA-001` | `MX-CS-011`,`MX-FED-008` | integration/load | media pipeline report | staging + pre-release | per release candidate | upload/download/thumbnail/remote cache 通过 | `evidence/L1/EVID-MEDIA-001/` | release lifetime | media |
| `EVID-DER-001` | `MX-CS-017`,`MX-FED-006` | integration/rebuild | derived-data report | staging + pre-release | per release candidate | search、目录、rebuild 一致性通过 | `evidence/L1/EVID-DER-001/` | release lifetime | derived services |
| `EVID-AS-001` | `MX-AS-001`,`MX-AS-002`,`MX-AS-003`,`MX-CS-017` | integration | appservice and derived-data report | staging | per release candidate when enabled | namespace、txn delivery、directory side-effects 通过 | `evidence/L3/EVID-AS-001/` | release lifetime | integrations |
| `EVID-SEC-001` | `REQ-SEC-*`,`MX-CS-002`,`MX-FED-002` | security | security verification bundle | staging + pre-release | per release candidate | token revocation、secret handling、abuse guards 通过 | `evidence/common/EVID-SEC-001/` | release lifetime + 1 audit cycle | security |
| `EVID-OPS-001` | `REQ-OPS-010`,`REQ-OPS-011`,`REQ-OPS-012` | deploy | rollout compatibility report | pre-release | per release candidate | new/old version skew tests通过 | `evidence/common/EVID-OPS-001/` | release lifetime | platform |
| `EVID-OPS-002` | `REQ-OPS-013`,`DATA-OPS-*` | recovery/drill | replay/rebuild/restore drill report | periodic drill | quarterly + pre-release for major releases | restore/rebuild 成功且 checkpoint/manifest 完整 | `evidence/L3/EVID-OPS-002/` | 2 years | platform + SRE |
| `EVID-PERF-001` | `REQ-OPS-001`,`REQ-OPS-002`,`REQ-OPS-003`,`REQ-OPS-004`,`REQ-OPS-005` | load | performance benchmark report | pre-release | per release candidate | `/sync`、hot room、derived lag budgets达标 | `evidence/common/EVID-PERF-001/` | release lifetime | performance |
| `EVID-COST-001` | `REQ-OPS-003`,`CF-WKR-015`,`CF-WKR-016`,`CF-WKR-017`,`CF-WKR-018`,`CF-WKR-019`,`CF-DO-011`,`CF-DO-012`,`CF-DO-013`,`CF-D1-006`,`CF-KV-003`,`CF-R2-005`,`CF-QUE-001` | cost | monthly dashboard snapshot + model comparison | prod + pre-release | monthly and pre-release | 主要计费面与预算模型一致，无异常漂移 | `evidence/common/EVID-COST-001/` | 13 months | platform finance |

## 4. Release Gate Evidence Sets

| Profile ID | Canonical Name | Mandatory EVID IDs |
| --- | --- | --- |
| `L1` | `Local-Core` | `EVID-GOV-001`,`EVID-CS-001`,`EVID-CS-002`,`EVID-CS-003`,`EVID-ROOM-001`,`EVID-ROOM-002`,`EVID-MEDIA-001`,`EVID-DER-001`,`EVID-SEC-001`,`EVID-OPS-001`,`EVID-COST-001` |
| `L2` | `Federation-Core` | `L1` + `EVID-FED-001`,`EVID-FED-002` |
| `L3` | `Enterprise-Hardening` | `L2` + `EVID-AS-001` when enabled, `EVID-OPS-002`,`EVID-PERF-001` |

## 5. Evidence Closure Rules

* `Required-Core` requirement 没有 `EVID-ID` 则视为未闭环。
* 证据必须可回链到 `REQ`、`MX`、`IF` 或 `DATA`，不能孤立存在。
* 失败证据必须保留并标注处置结果。
* waived 证据必须指向 `DEC-ID`，说明豁免范围和失效时间。

## 6. 审计规则

* 发布评审必须基于证据寄存器，而不是口头结论。
* 任何 `pass` 证据都必须有明确生成环境、时间戳、代码版本和数据版本上下文。
* 任何人工步骤都必须记录执行者与审查者。

## 7. 完成标准

* 验证和证据已经分离建模；
* 任何规范声明都能知道要看什么证据；
* 发布门禁可被审计；
* 可直接支持企业级发布评审。
