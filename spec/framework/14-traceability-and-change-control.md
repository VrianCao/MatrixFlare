# Traceability and Change Control

状态：Draft-Normative
角色：追溯与变更控制分册  
负责主文档章节：1，7  
扩展范围：全部文档体系

## 1. 文档职责

* 定义 requirement、constraint、contract、data、flow、test、evidence 之间的追溯规则。
* 定义文档变更包的最小组成与合并门禁。
* 定义如何防止“代码先变、文档后补”的真相漂移。

## 2. 工件分类

* `REQ`：实现或运营必须满足的规范要求
* `MX`：Matrix 协议覆盖条目
* `CF`：Cloudflare 平台约束
* `IF`：接口契约
* `DATA`：数据契约
* `FLOW`：时序图
* `STATE`：状态机
* `TEST`：测试项
* `EVID`：验证证据
* `DEC`：决策
* `OQ`：未决问题

### 2.1 `DEC` / `OQ` 寄存器约定

* `DEC` 文档必须存放在 `spec/decisions/<DEC-ID>.md`。
* `OQ` 文档必须存放在 `spec/open-questions/<OQ-ID>.md`。
* `90-open-questions.md` 与 `91-decision-log.md` 只允许作为目录跳转页；不得再被引用为 `DEC` / `OQ` 的权威正文。
* 每个 `DEC` 至少包含：状态、结论、原因、影响的 `REQ/MX/CF/IF/DATA/TEST/EVID`、owner、批准日期、失效或复审日期。
* Evidence waiver、规范冲突裁决和恢复例外都必须引用已存在的 `DEC-ID`，不得只写自然语言说明。
* `OQ` 不得只因为“先降级成 Deferred / Conditional”就被标记为 `closed`；只有当其 `affected IDs` 已全部落为 canonical `IF/DATA/FLOW/TEST/EVID`，或被 `DEC-ID` 明确收敛为稳定产品边界时，才允许关闭。

## 3. 必须建立的双向链接

### 3.1 Requirement 链接规则

每个 `REQ` 必须能双向链接到：

* 上游来源
* Owning spec
* Owning runtime component
* 一个或多个 `IF`
* 一个或多个 `DATA`
* 零个或多个 `FLOW` / `STATE`
* 一个或多个 `TEST`
* 至少一个 `EVID`

说明：

* 各 owning spec 内的 `REQ` 表可以保持精简表头，但上述 `REQ -> IF/DATA/FLOW/STATE/TEST/EVID` 边必须完整进入 [7.2](#72-机器可审计编码位置) 规定的 traceability matrix。
* 若某条 `REQ` 的双向链接无法从现有 canonical 寄存器字段、显式注释或权威 sidecar 确定性生成，则不得仅存在于自然语言段落；必须先补充可机审字段后，才可宣称闭环。
* 当前仓库用于补齐 `REQ` 闭环的权威 sidecar 路径固定为 `spec/framework/14-requirement-traceability-sidecar.json`；其中每个 `req_id` 至少必须显式列出 `runtime_owners`、`if_ids`、`data_ids`、`flow_state_ids`、`test_ids`、`evid_ids`。

### 3.1.1 `REQ` 的规范正文与机器权威

* 每条 `REQ` 的规范正文只允许出现在 owning spec 的显式 `REQ` 表行中；该行至少必须包含 `REQ ID`、短名称/主题与 normative statement。
* `TEST-GOV-001` / `EVID-GOV-001` 必须从全部 canonical `REQ` 表行生成 machine-readable requirement register；该 register 是 `REQ-*` wildcard 展开、`REQ` 反向追溯与 requirement 唯一性校验的唯一机器基线。
* requirement register 工件路径固定为：
  * `evidence/common/EVID-GOV-001/<run_ts>/artifacts/requirement-register.csv`
  * `evidence/common/EVID-GOV-001/<run_ts>/artifacts/requirement-register.json`
* requirement register 至少必须输出：`req_id`、`owning_spec`、`title`、`normative_statement`、`source_file`、`source_line`、`status`。
* 若同一 `REQ ID` 在多个源位置出现，或出现在与 [11-spec-authority-and-version-policy.md](/root/Matrix/spec/framework/11-spec-authority-and-version-policy.md) 前缀归属不一致的正文位置，治理门禁必须直接 fail。

### 3.2 Constraint 链接规则

每个 `CF` 必须能双向链接到：

* 受影响分册
* 受影响组件
* 缓解策略
* 验证方式

### 3.3 Contract 链接规则

每个 `IF` 与 `DATA` 必须能双向链接到：

* 产生它的 requirement
* 使用它的组件
* 验证它的测试

## 4. 变更包最小清单

任何影响行为的变更都必须同步修改：

* 至少一个责任分册；
* 相关 `MX` 或 `CF` 条目；
* 相关 `IF` 与 `DATA` 条目；
* 相关 `FLOW` / `STATE` 条目；
* 相关 `TEST` 与 `EVID` 条目；
* 必要时的 `DEC` 或 `OQ`。

## 5. 漂移防控规则

### 5.1 文档先行规则

* 新行为在代码落地前，必须先有 requirement 与 contract 定义。
* 若因紧急修复必须先改代码，则同一变更包内必须补齐文档。

### 5.2 单一主责规则

* 同一 requirement 只能有一个主责正文位置。
* 其他文档只能引用，不得重新定义。

### 5.3 证据闭环规则

* 没有 `TEST` 与 `EVID` 的 requirement，不得进入 `Normative`。

### 5.4 Canonical ID 规则

* `MX`、`IF`、`DATA`、`FLOW`、`STATE`、`TEST`、`EVID` 字段中禁止使用 `reserved`、`future profile`、`session contracts`、`session flows` 等自然语言占位符代替 canonical ID。
* 若某能力当前未定义对应契约，必须显式写 `none`，或把该能力降为 `Deferred` / `Unsupported` 并补充说明。
* 任何 “ID 列表” 字段都必须使用逗号分隔的完整 canonical IDs，或使用对应寄存器明确允许的末尾 `*` 通配；禁止区间缩写、后缀缩写和隐式继承前缀的写法。
* 本规则适用于 `REQ`、`MX`、`CF`、`IF`、`DATA`、`FLOW`、`STATE`、`TEST`、`EVID`、`DEC`、`OQ` 的所有寄存器、目录和证据字段；进入仓库前必须可被机器稳定解析。

## 6. 审查与合并门禁

每次合并至少需要通过以下审查：

* 规范边界审查
* 协议覆盖审查
* Cloudflare 贴合性审查
* 契约一致性审查
* 测试与证据审查

## 7. 追溯矩阵输出

后续必须生成至少以下矩阵：

* `REQ -> MX -> Spec -> Runtime`
* `REQ -> IF -> DATA`
* `REQ -> FLOW/STATE`
* `REQ -> TEST -> EVID`
* `CF -> Impacted Spec -> Mitigation`
* `DEC -> Impacted Requirement`

### 7.1 最小矩阵表头

| Source ID | Source Type | Target ID | Target Type | Link Reason | Owning Spec | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `REQ-*` / `MX-*` / `CF-*` | requirement / coverage / constraint | `IF-*` / `DATA-*` / `FLOW-*` / `STATE-*` / `TEST-*` / `EVID-*` / `DEC-*` | contract / flow / state-machine / test / evidence / decision | implements / constrains / models / verifies / changes | owning child spec | open / active / closed |

### 7.2 机器可审计编码位置

双向追溯的唯一机器权威编码固定为 `EVID-GOV-001` 产出的 traceability matrix 工件：

* `evidence/common/EVID-GOV-001/<run_ts>/artifacts/requirement-register.csv`
* `evidence/common/EVID-GOV-001/<run_ts>/artifacts/requirement-register.json`
* `evidence/common/EVID-GOV-001/<run_ts>/artifacts/traceability-matrix.csv`
* `evidence/common/EVID-GOV-001/<run_ts>/artifacts/traceability-matrix.json`

规则：

* 所有 `REQ-*` wildcard、`Source IDs` 中涉及 `REQ-*` 的展开、以及从 `REQ` 出发的反向追溯，都必须先解析 requirement register，而不是扫描仓库文本。
* `spec/framework/14-requirement-traceability-sidecar.json` 是当前仓库 `REQ -> runtime/IF/DATA/FLOW/STATE/TEST/EVID` 边的唯一权威输入；`TEST-GOV-001` 必须校验其与 canonical IDs、requirement register 和 traceability matrix 一致。
* `IF` / `DATA` 目录表可以不内联 `Source IDs` 或 `TEST IDs` 列，前提是上述 matrix 能从现有 canonical 寄存器字段中确定性推导出反向链接。
* `TEST-GOV-001` 必须在每次 CI 运行时重新生成 requirement register 与 traceability matrix，并对断链、歧义链接、缺失反向边、重复 `REQ ID` 与未登记 ID 直接 fail。
* 任何无法被上述 matrix 表达的链接需求，都不得仅存在于自然语言段落；必须先进入 canonical 寄存器字段或新增权威寄存器后，才可宣称闭环。

## 8. 完成标准

* 全部工件类型已定义；
* 双向追溯规则已清楚；
* 文档和代码漂移有明确防线；
* 可直接作为后续治理与发布门禁基础。
