# spec-tools

`packages/spec-tools/` 是 `Phase 00` 的治理工具入口。

当前能力：

* 扫描 `spec/framework/`、`spec/decisions/`、`spec/open-questions/` 的 canonical IDs
* 生成 machine-readable `requirement-register`
* 生成双向 `traceability-matrix`
* 展开 `23-interface-contract-catalog.md` 中带 `*` 的 Matrix route family
* 执行 `TEST-GOV-001` / 产出 `EVID-GOV-001`

根脚本入口：

* `npm run governance:check`
* `npm run governance:evidence`
* `npm run governance:requirement-register`
* `npm run governance:traceability-matrix`
* `npm run governance:expand-routes`
