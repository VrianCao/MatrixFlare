# Appendices

状态：Draft-Normative
角色：附录分册  
负责主文档章节：8  
继承的单体章节：28

## 1. 文档职责

* 维护不适合进入正文但对开发与运维仍然必要的材料入口。
* 统一管理术语、缩写、图例、资料清单、工具入口、仓库布局、里程碑等附录信息。

## 2. 待填充章节

除 `2.9` 外，本节当前各小节均为 `Placeholder/Informative` 入口，不得被当作现行规范基线引用；`TEST-GOV-001` 必须禁止正文把 `2.1-2.8` 当作 normative source。

### 2.1 Terminology and Acronyms

### 2.2 Source Packs and Research Artifacts

### 2.3 Pricing and Estimation Tooling

### 2.4 Repository Layout

### 2.5 Delivery Milestones

### 2.6 Glossary of Cloudflare-Specific Terms

### 2.7 Glossary of Matrix-Specific Terms

### 2.8 Templates and Control Artifacts

### 2.9 Matrix `v1.17` Default Push-Rules Baseline

本节是 `spec/framework/30-client-identity-and-sync.md` 所引用的规范性基线。服务端生成的 `global` server-default push rules 必须与本节**完全等价**。

#### 2.9.1 总规则

* `override`、`underride`、`sender`、`room`、`content` 五类数组都必须存在于 server-generated baseline view 中。
* `sender`、`room`、`content` 三类在 Matrix `v1.17` baseline 中默认是空数组。
* `.m.rule.master` 是唯一一个始终高于全部其他规则的 server-default rule；即使存在用户自定义规则，它也必须保持最前。
* 除 `.m.rule.master` 外，其余 server-default rules 的相对顺序固定如下，不允许被用户 `before` / `after` 重排。
* Matrix `v1.17` 已移除 legacy “按 `content.body` 搜索 mention” 的默认规则；本基线不得再包含这类旧规则。

#### 2.9.2 `override` Baseline Order

| Order | Rule ID | Enabled | Conditions | Actions |
| --- | --- | --- | --- | --- |
| 1 | `.m.rule.master` | `false` | always match (`conditions = []`) | `[]` |
| 2 | `.m.rule.suppress_notices` | `true` | `event_match(content.msgtype == "m.notice")` | `[]` |
| 3 | `.m.rule.invite_for_me` | `true` | `event_match(type == "m.room.member")` + `event_match(content.membership == "invite")` + `event_match(state_key == [the user's Matrix ID])` | `notify` + `set_tweak(sound="default")` |
| 4 | `.m.rule.member_event` | `true` | `event_match(type == "m.room.member")` | `[]` |
| 5 | `.m.rule.is_user_mention` | `true` | `event_property_contains(content.m.mentions.user_ids, [the user's Matrix ID])` | `notify` + `set_tweak(sound="default")` + `set_tweak(highlight=true)` |
| 6 | `.m.rule.is_room_mention` | `true` | `event_property_is(content.m.mentions.room, true)` + `sender_notification_permission(room)` | `notify` + `set_tweak(highlight=true)` |
| 7 | `.m.rule.tombstone` | `true` | `event_match(type == "m.room.tombstone")` + `event_match(state_key == "")` | `notify` + `set_tweak(highlight=true)` |
| 8 | `.m.rule.reaction` | `true` | `event_match(type == "m.reaction")` | `[]` |
| 9 | `.m.rule.room.server_acl` | `true` | `event_match(type == "m.room.server_acl")` + `event_match(state_key == "")` | `[]` |
| 10 | `.m.rule.suppress_edits` | `true` | `event_property_is(content.m.relates_to.rel_type, "m.replace")` | `[]` |

#### 2.9.3 `underride` Baseline Order

| Order | Rule ID | Enabled | Conditions | Actions |
| --- | --- | --- | --- | --- |
| 1 | `.m.rule.call` | `true` | `event_match(type == "m.call.invite")` | `notify` + `set_tweak(sound="ring")` |
| 2 | `.m.rule.encrypted_room_one_to_one` | `true` | `room_member_count(is == "2")` + `event_match(type == "m.room.encrypted")` | `notify` + `set_tweak(sound="default")` |
| 3 | `.m.rule.room_one_to_one` | `true` | `room_member_count(is == "2")` + `event_match(type == "m.room.message")` | `notify` + `set_tweak(sound="default")` |
| 4 | `.m.rule.message` | `true` | `event_match(type == "m.room.message")` | `notify` |
| 5 | `.m.rule.encrypted` | `true` | `event_match(type == "m.room.encrypted")` | `notify` |

#### 2.9.4 Implementation Binding Rules

* `DATA-USER-013` 只持久化用户覆盖、禁用与用户规则顺序；不得把本附录中的 default rules 物化成“可被用户重排的普通行”再在读时猜测原顺序。
* `GET /pushrules/` 与 `GET /pushrules/global/` 返回的 default rules 必须由“本附录基线 + 用户覆盖”组合而成。
* 任何 Matrix 基线版本升级都必须先复制本节为新的 versioned appendix，再由 [11-spec-authority-and-version-policy.md](/root/Matrix/spec/framework/11-spec-authority-and-version-policy.md) 流程推动变更；禁止静默改写 `v1.17` baseline。

## 3. 必备附件

* 术语表
* 附录索引表
* 仓库结构图
* 里程碑表
* 模板与控制工件索引

## 4. 完成标准

* 所有正文需要引用的附录入口齐全；
* 附录不与正文职责重叠；
* 文档体系所需模板和辅助工件可定位；
* 开发团队能快速定位术语、目录与辅助材料。
