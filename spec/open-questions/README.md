# Open Question Register

本目录用于存放尚未收敛的规范问题。

约束：

* 文件名必须是 `<OQ-ID>.md`，例如 `OQ-0001.md`。
* 每个问题必须至少包含：status、title、opened date、owner、affected IDs、question、options、next review date。
* 一旦问题被裁决，必须新增对应 `DEC-ID`，并把相关 evidence / requirement / contract 回链到该决策。
* `affected IDs` 只能使用完整 canonical IDs 的显式枚举；禁止区间写法、后缀缩写或自然语言占位。
* 若问题来自“当前先降级为 `Deferred` / `Conditional`”，则关闭前必须满足二选一：相关 surface 已补齐 `IF/DATA/FLOW/TEST/EVID`，或已有 `DEC-ID` 把该 surface 固化为稳定产品边界。
* `affected IDs` 必须覆盖问题正文中被点名的全部 canonical `MX/IF/DATA/TEST/EVID/DEC/OQ`；遗漏任一已点名 canonical ID 视为不合格问题单。
