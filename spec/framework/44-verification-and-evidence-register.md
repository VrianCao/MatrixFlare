# Verification and Evidence Register

状态：Outline  
角色：验证证据分册  
负责主文档章节：7  
扩展范围：全部 requirement / contract / constraint 的验证闭环

## 1. 文档职责

* 统一登记测试证据与发布门禁证据。
* 把“通过了什么、如何证明、证据存在哪里”从测试策略中分离出来。
* 为“文档即真相”补齐可验证性闭环。

## 2. 证据条目模型

每个证据条目至少需要包含：

* `EVID-ID`
* 对应 `REQ` / `MX` / `CF` / `IF` / `DATA`
* 证据类型
* 生成方式
* 生成环境
* 触发频率
* 保留策略
* Owning team / role
* 判定标准
* 结果位置

### 2.1 标准表头

| EVID-ID | Source IDs | Evidence Type | Generation Method | Environment | Frequency | Pass Criteria | Artifact Location | Retention | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `EVID-*` | `REQ-*` / `MX-*` / `CF-*` / `IF-*` / `DATA-*` | unit / integration / protocol / load / chaos / deploy / recovery / security | CI / manual runbook / scheduled drill | local / staging / preprod / prod shadow | per commit / nightly / pre-release / periodic | explicit measurable rule | report path / dashboard / log bundle | N days / release lifetime | team / role |

### 2.2 颗粒度规则

* 一个 `EVID-ID` 只表示一个可独立审计的证据工件。
* 同一测试在不同环境得到的结果若结论不同，必须拆分证据条目。
* 证据条目必须可复现或可重新生成，除非其本质是一次性事故证据。

## 3. 证据类型分组

* 单元测试结果
* 属性测试结果
* 集成测试结果
* 协议合规测试结果
* 负载测试结果
* 联邦混沌测试结果
* 部署兼容测试结果
* 成本与容量验证结果
* 恢复与回放演练结果
* 安全验证结果

## 4. 发布门禁结构

每个发布 profile 后续至少需要定义：

* 必须通过的 `TEST` 集合
* 必须存在的 `EVID` 集合
* 允许的 open questions 范围
* 允许的 deferred coverage 范围
* 不可接受的 platform risk 范围

## 5. 证据闭环规则

* `Normative` requirement 没有证据条目则视为未闭环。
* 证据必须能回链到需求与接口/数据契约，而不是孤立存在。
* 失败证据不能删除，只能保留并标注处置结果。

## 6. 完成标准

* 验证和证据已经分离建模；
* 任何规范声明都能知道要看什么证据；
* 发布门禁可被审计；
* 可直接支持企业级发布评审。
