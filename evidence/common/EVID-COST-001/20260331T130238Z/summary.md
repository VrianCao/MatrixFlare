# EVID-COST-001 Summary

- status: pass
- generated_at: 2026-03-31T13:02:45.600Z
- run_ts: 20260331T130238Z
- scope: common
- target_profile: L1
- evidence_type: cost
- generation_method: monthly dashboard snapshot + model comparison
- repo_root: /root/Matrix

## Context

- code_version.git_commit: `74a3ba7dbe2cc0199e210b812773ec4dfdbea480`
- code_version.worktree_dirty: true
- data_version.analysis_sha256: `034f0133cec010cd40cd6631dc1a3f232ed1d1a51fb9a94256bcff093680fab8`
- data_version.requirement_register_sha256: `b6b25c4daffa1b2fc12da4d3bbd65fef4135d9261a8c7407e19d3e1458d8864a`
- data_version.traceability_matrix_sha256: `5a5cb8f997a55a45c42e55336397d1792cd84d0c85a978001b568fa6b8df8722`
- data_version.expanded_source_ids_sha256: `2502cfd5a15dba976fe5887a2d87abf2ed8aaf2144860b19a8ec99ae74285604`
- data_version.wildcard_route_expansion_sha256: `36a11aa9bc55e0800be48548c8c6beb38ee55c54981bf5e9c2b1c7940a4492ac`
- governance_valid: true

## Source IDs

- declared_source_ids: `REQ-OPS-003`, `CF-WKR-015`, `CF-WKR-016`, `CF-WKR-017`, `CF-WKR-018`, `CF-WKR-019`, `CF-DO-011`, `CF-DO-012`, `CF-DO-013`, `CF-D1-006`, `CF-KV-003`, `CF-R2-005`, `CF-QUE-001`
- expanded_source_ids: `CF-D1-006`, `CF-DO-011`, `CF-DO-012`, `CF-DO-013`, `CF-KV-003`, `CF-QUE-001`, `CF-R2-005`, `CF-WKR-015`, `CF-WKR-016`, `CF-WKR-017`, `CF-WKR-018`, `CF-WKR-019`, `REQ-OPS-003`
- applicable_source_ids: `CF-D1-006`, `CF-DO-011`, `CF-DO-012`, `CF-DO-013`, `CF-KV-003`, `CF-QUE-001`, `CF-R2-005`, `CF-WKR-015`, `CF-WKR-016`, `CF-WKR-017`, `CF-WKR-018`, `CF-WKR-019`, `REQ-OPS-003`

## Required Tests

- `TEST-COST-001`

## Environment Results

- required `pre-release`: pass (exit=0, duration_ms=11953)
  artifacts: `../../_test-runs/20260331T130238Z/pre-release.log`, `../../_test-runs/20260331T130238Z/pre-release.json`
- supporting `local`: pass (exit=0, duration_ms=11844)
  artifacts: `../../_test-runs/20260331T130238Z/local.log`, `../../_test-runs/20260331T130238Z/local.json`
- supporting `ci-integration`: pass (exit=0, duration_ms=11905)
  artifacts: `../../_test-runs/20260331T130238Z/ci-integration.log`, `../../_test-runs/20260331T130238Z/ci-integration.json`
- supporting `staging`: pass (exit=0, duration_ms=11288)
  artifacts: `../../_test-runs/20260331T130238Z/staging.log`, `../../_test-runs/20260331T130238Z/staging.json`

## Pass Criteria

- Metrics and cost-attribution surfaces must produce stable pre-release evidence without budget-model drift signals.

## Artifacts

- `artifacts/context.json`
- `artifacts/source-ids.json`
- `artifacts/environment-results.json`
