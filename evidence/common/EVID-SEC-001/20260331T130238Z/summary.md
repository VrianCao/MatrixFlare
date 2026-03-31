# EVID-SEC-001 Summary

- status: pass
- generated_at: 2026-03-31T13:02:45.600Z
- run_ts: 20260331T130238Z
- scope: common
- target_profile: L1
- evidence_type: security
- generation_method: security verification bundle
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

- declared_source_ids: `REQ-SEC-*`, `MX-CS-002`, `MX-CS-003`, `MX-CS-005`, `MX-CS-016`, `MX-CS-024`, `MX-CS-025`, `MX-CS-026`, `MX-CS-028`, `MX-FED-002`
- expanded_source_ids: `MX-CS-002`, `MX-CS-003`, `MX-CS-005`, `MX-CS-016`, `MX-CS-024`, `MX-CS-025`, `MX-CS-026`, `MX-CS-028`, `MX-FED-002`, `REQ-SEC-001`, `REQ-SEC-002`, `REQ-SEC-003`, `REQ-SEC-004`, `REQ-SEC-005`, `REQ-SEC-006`, `REQ-SEC-007`, `REQ-SEC-008`
- applicable_source_ids: `MX-CS-002`, `MX-CS-003`, `MX-CS-005`, `MX-CS-016`, `MX-CS-024`, `MX-CS-025`, `MX-CS-026`, `MX-CS-028`, `REQ-SEC-001`, `REQ-SEC-002`, `REQ-SEC-003`, `REQ-SEC-004`, `REQ-SEC-006`, `REQ-SEC-007`, `REQ-SEC-008`

## Required Tests

- `TEST-SEC-001`

## Environment Results

- required `staging`: pass (exit=0, duration_ms=11288)
  artifacts: `../../_test-runs/20260331T130238Z/staging.log`, `../../_test-runs/20260331T130238Z/staging.json`
- required `pre-release`: pass (exit=0, duration_ms=11953)
  artifacts: `../../_test-runs/20260331T130238Z/pre-release.log`, `../../_test-runs/20260331T130238Z/pre-release.json`
- supporting `local`: pass (exit=0, duration_ms=11844)
  artifacts: `../../_test-runs/20260331T130238Z/local.log`, `../../_test-runs/20260331T130238Z/local.json`
- supporting `ci-integration`: pass (exit=0, duration_ms=11905)
  artifacts: `../../_test-runs/20260331T130238Z/ci-integration.log`, `../../_test-runs/20260331T130238Z/ci-integration.json`

## Pass Criteria

- For L1, token revocation, UIA route binding, secret handling, and baseline abuse guards on always-on surfaces must pass in staging and pre-release.

## Artifacts

- `artifacts/context.json`
- `artifacts/source-ids.json`
- `artifacts/environment-results.json`
