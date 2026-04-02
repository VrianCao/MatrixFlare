# Source Observation Register

状态：Draft-Normative
角色：上游来源巡检寄存器
负责主文档章节：1
扩展范围：Matrix 与 Cloudflare 上游事实漂移审计

## 1. 文档职责

* 作为上游来源观察记录的唯一权威文件。
* 固定 Matrix 与 Cloudflare 观察日期、已钉死基线、最新观察结果、delta 结论与后续动作。
* 为版本升级、上游漂移审查、`TEST-GOV-001` 与 `EVID-GOV-001` 提供机器可审计输入。

明确不包含：

* 不直接替代 `11` 的权威与版本治理规则；
* 不直接替代 `13` 的 Cloudflare 约束台账；
* 不直接替代 `research/sources/` 快照本体。

## 2. 寄存器规则

* 本文件是 `11-spec-authority-and-version-policy.md` 中 “来源巡检寄存器” 的唯一权威落位。
* 每一行都必须对应一个可审计的 source family 或紧密耦合的页面集合，不得把互不相关的产品线混成单行。
* `Pinned Baseline` 必须引用已进入现行规范体系的版本或本地快照集合。
* `Observed Latest` 必须反映最近一次人工或自动巡检时看到的上游最新值。
* `Delta Summary` 只允许 `none`、`additive`、`breaking`、`unclear` 四类。
* 若 `Delta Summary != none`，则 `Action Required` 不得为 `no-op`。
* `TEST-GOV-001` 必须校验本文件存在、字段完整、日期合法且与相关治理分册引用一致。

## 3. Observation Register

| Source Family | Pinned Baseline | Observed Latest | Observation Date | Delta Summary | Action Required | Owner | Review Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Matrix client/server/federation/application-service/rooms | local snapshots `research/sources/matrix-v1.17-client-server-api.html`,`research/sources/matrix-v1.17-server-server-api.html`,`research/sources/matrix-v1.17-application-service-api.html`,`research/sources/matrix-v1.17-rooms.html`,`research/sources/matrix-v1.17-room-v11.html`,`research/sources/matrix-v1.17-room-v12.html` | Matrix `latest` observed as `v1.17` | `2026-03-26` | `none` | `no-op` | architecture | pre-release + monthly |
| Cloudflare Workers runtime and pricing surfaces | local snapshots `research/sources/cloudflare-workers-limits.md`,`research/sources/cloudflare-workers-pricing.md`,`research/sources/cloudflare-workers-logs.md`,`research/sources/cloudflare-workers-opentelemetry.md`,`research/sources/cloudflare-workers-traces.html`,`research/sources/cloudflare-workers-rpc.md`,`research/sources/cloudflare-service-bindings.md`,`research/sources/cloudflare-workers-placement.md`,`research/sources/cloudflare-workers-gradual-deployments.md`,`research/sources/cloudflare-workers-versions-deployments.md`,`research/sources/cloudflare-workers-secrets.md`,`research/sources/cloudflare-workers-nodejs-apis.md`,`research/sources/cloudflare-workers-nodejs-process.md`,`research/sources/cloudflare-workers-rate-limit.md` | named environments, service bindings, deployments/versions, and secret-on-deploy semantics still support current `CF-WKR-*` rows; current versions/deployments docs also state that a deployment containing a specified version may not have propagated yet, so active deployment identity alone is not a sufficient readiness signal for release-gate suites; Workers Rate Limiting bindings remain local-to-location and permissive rather than globally strict, which is acceptable for coarse gateway shaping but not for semantic quota truth; observability pricing pages still conflict, Billing Usage/Paygo automation remains beta/select-account scoped for production cost evidence, and current Workers runtime still requires feature-detecting some `nodejs_compat` helpers in app code because request paths observed on `2026-04-01` fail if telemetry hard-depends on unimplemented `process.cpuUsage()` | `2026-04-02` | `unclear` | `track OQ-0002`, keep tracing/cost assertions parameterized, do not mark EVID-COST-001 automatable until target-account billing API access is proven, keep runtime telemetry fail-safe against unavailable Node compatibility helpers, use Workers Rate Limiting bindings only for coarse gateway shaping rather than semantic quota truth, and require a bounded post-deploy readiness gate before non-local suites start` | platform | pre-release + monthly |
| Cloudflare storage and queue surfaces | local snapshots `research/sources/cloudflare-do-limits.md`,`research/sources/cloudflare-do-lifecycle.md`,`research/sources/cloudflare-do-alarms.md`,`research/sources/cloudflare-do-known-issues.md`,`research/sources/cloudflare-do-rpc-stubs.md`,`research/sources/cloudflare-do-migrations.md`,`research/sources/cloudflare-do-sqlite-storage-api.md`,`research/sources/cloudflare-do-websockets.md`,`research/sources/cloudflare-do-pricing.md`,`research/sources/cloudflare-d1-limits.md`,`research/sources/cloudflare-d1-read-replication.md`,`research/sources/cloudflare-d1-pricing.md`,`research/sources/cloudflare-kv-how-it-works.md`,`research/sources/cloudflare-r2-consistency.md`,`research/sources/cloudflare-r2-limits.md`,`research/sources/cloudflare-r2-pricing.md`,`research/sources/cloudflare-queues-pricing.md`, official docs `https://developers.cloudflare.com/d1/worker-api/d1-database/`,`https://developers.cloudflare.com/d1/worker-api/prepared-statements/` | account-level D1/KV/R2/Queue list/create APIs still support deterministic non-local harness provisioning and environment-scoped resource isolation; current DO RPC semantics require method-call targets to inherit the Workers runtime `DurableObject` base; current Durable Object docs still state code updates are globally eventually consistent for seconds to minutes, which is consistent with the `2026-04-01` auditable observation that `staging` could fail immediately after deploy on a remote request path even after workflow deployment steps completed, but current artifacts still do not prove the exact blocker is only a readiness window; current SQLite-backed DO docs still require `ctx.storage.transaction()` / `transactionSync()` instead of raw `BEGIN` / `SAVEPOINT`; and current D1 Worker Binding docs continue to describe `exec()` as a less-safe maintenance / one-shot surface whose input can contain one or multiple queries separated by `\n`, so request-path schema bootstrap must prefer prepared statements over multiline `exec()` literals | `2026-04-01` | `additive` | `keep non-local provisioning idempotent, verify both DO RPC and SQLite transaction semantics under workerd/non-local harness before claiming remote truth-path coverage, keep D1 request-path bootstrap on prepared statements rather than multiline exec literals, require representative HTTP read/write readiness probes before suite execution, and continue verifying resource/API semantics before release automation changes` | platform | pre-release + monthly |
| Cloudflare network and access control surfaces | local snapshots `research/sources/cloudflare-network-ports.md`,`research/sources/cloudflare-access-application-paths.md`,`research/sources/cloudflare-access-applications.md`,`research/sources/cloudflare-access-validate-jwt.md`,`research/sources/cloudflare-access-service-tokens.md`,`research/sources/cloudflare-workers-dev.md` | current Access docs still match `CF-NET-004`-`006` on JWT validation and service-token semantics; self-hosted public Access applications still require active-zone domains, while current Workers docs also explicitly allow enabling Access on account-owned `workers.dev` and Preview URLs. This invalidates the older assumption that active-zone custom hostnames are the only legal non-local ops ingress, but the repo still lacks actual Access enablement, real team-domain/AUD inputs, and a supported automation contract for `/_ops`, so `TEST-DER-001` rebuild coverage and `TEST-OPS-001` non-local skew proof still cannot honestly close on bare `workers.dev` URLs plus `.cloudflareaccess.invalid` placeholders alone | `2026-04-02` | `unclear` | `track OQ-0004`, update `CF-NET-007` to reflect both self-hosted and workers.dev Access paths, do not treat placeholder Access team domains or unauthenticated workers.dev URLs as sufficient for authenticated non-local control-plane coverage, and require a resolved Access ingress + automation plan before claiming `TEST-DER-001` / `TEST-OPS-001` closure` | security + platform | pre-release + monthly |
| GitHub Actions deployment, artifact, and identity surfaces | official docs `https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment`,`https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs`,`https://github.com/actions/upload-artifact`,`https://docs.github.com/en/actions/reference/security/oidc` | environments can be auto-created when referenced, concurrency groups remain the control primitive for duplicate-run safety, `upload-artifact@v4` exposes immutable artifact IDs/URLs/digests suitable for supplemental provenance, and GitHub OIDC tokens remain available only to jobs with `id-token: write`, carrying run/repository/environment claims usable to hard-fail local spoofed non-local entrypoints | `2026-04-01` | `additive` | `use GitHub Actions as the sole non-local entry, keep R2 immutable object references as the required attestation artifact store, and require GitHub-signed OIDC job identity before stateful non-local tooling runs` | platform | pre-release + monthly |

## 4. Drift Handling Rules

* 若某行出现 `additive` 或 `unclear` delta，相关 owner 必须在同一轮审查中决定是更新现行规范、登记 `OQ-ID`，还是创建 `DEC-ID` 维持现状。
* 若某行出现 `breaking` delta，则在受影响 `REQ/MX/CF/IF/DATA/TEST/EVID` 更新前，不得继续宣称对应能力的发布基线未变。
* `Action Required` 不是 `no-op` 的行，必须在下次 release gate 前关闭为 `DEC-ID`、文档更新，或明确的延期决策。

## 5. 完成标准

* 来源观察记录有唯一权威文件；
* Matrix 与 Cloudflare 观察口径已统一；
* 上游漂移能够进入变更控制与发布门禁；
* 开发与审计团队都能据此判断“当前基线是否仍成立”。
