# Evidence Artifact Tree

本目录承载 `spec/framework/44-verification-and-evidence-register.md` 定义的证据工件路径。

约束：

* 规范性产物路径以 `44` 分册为准。
* 当前仓库只预置最小骨架，具体 `summary.md` 与 `artifacts/*` 由 CI、staging、pre-release 或演练流程生成。
* 空目录使用 `.gitkeep` 保持可追踪。
* `EVID-GOV-001` 的治理产物至少应包含：
  * `artifacts/requirement-register.csv`
  * `artifacts/requirement-register.json`
  * `artifacts/traceability-matrix.csv`
  * `artifacts/traceability-matrix.json`
  * wildcard route family 的实际展开审计快照
