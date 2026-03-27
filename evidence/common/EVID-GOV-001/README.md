# EVID-GOV-001

本目录承载 `TEST-GOV-001` 的治理证据。

约束：

* 每次运行写入 `evidence/common/EVID-GOV-001/<run_ts>/`
* 最少工件固定为：
  * `summary.md`
  * `artifacts/requirement-register.csv`
  * `artifacts/requirement-register.json`
  * `artifacts/traceability-matrix.csv`
  * `artifacts/traceability-matrix.json`
  * `artifacts/expanded-source-ids.json`
  * `artifacts/wildcard-route-expansion.csv`
  * `artifacts/wildcard-route-expansion.json`
* 若治理检查失败，也必须保留失败证据
