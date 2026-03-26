# AGENTS.md

## Current Phase

As of `2026-03-26`, this project has finished the Research phase and is entering AI-driven Development.

This repository is therefore **Spec-First**, not code-first:

* `research/` and `notes/` are completed input materials.
* `spec/framework/` is the implementation source of truth.
* `TODO.md` is the ordered execution backlog derived from the Spec.
* future code, tests, and evidence must be derived from the Spec stack.

## Execution Model

The repository now has two distinct control documents:

* `spec/framework/` tells you **what is true**.
* `TODO.md` tells you **what to do next**.

Priority rule:

* if `TODO.md` conflicts with the Spec, the Spec wins
* if the Spec changes, `TODO.md` must be updated in the same change set
* if a task is missing from `TODO.md`, add it in dependency order before or during implementation

## TODO-Driven Work Selection

Unless the user explicitly asks for a different scope, agents must pick work from the earliest unfinished item in `TODO.md` whose prerequisites are satisfied.

Do not:

* skip ahead to a later feature because it looks easier
* implement a later domain while an earlier foundation task is still missing
* mark a TODO item complete unless its stated outputs and gates are actually satisfied

If you discover that an earlier prerequisite is missing or wrong:

* stop the later implementation
* add or fix the prerequisite item in `TODO.md`
* do the prerequisite work first

## Mission

AI agents working in this repository must help move the project through this loop:

1. research facts are collected from official sources
2. facts are promoted into the Spec system
3. code is implemented strictly from the Spec
4. behavior is verified against `TEST-*` and `EVID-*`
5. bugs and drift are fed back into Spec or code, then the loop repeats

Do not skip the Spec step.

## Non-Negotiables

* No feature implementation from `research/` or `notes/` alone.
* No “infer the likely behavior and code it first”.
* No silent divergence from `REQ-*`, `MX-*`, `CF-*`, `IF-*`, `DATA-*`, `FLOW-*`, `STATE-*`.
* No full implementation of anything marked `Stub-Only`, `Deferred`, or `Unsupported`.
* No claiming a release profile (`L1`/`L2`/`L3`) without the mapped tests and evidence.

If the Spec is not ready, the correct action is to improve the Spec, open an `OQ-*`, or add a `DEC-*`, not to improvise in code.

## Source Of Truth Hierarchy

Implementation work must consume the stack in this order.

### Layer 0: Research Inputs

Files:

* `research/`
* `notes/`
* `spec/matrix-homeserver-cloudflare-spec.md`

Usage:

* input only
* never sufficient to justify code behavior on their own

### Layer 1: Governance And Authority

Files:

* `spec/framework/10-governance-and-references.md`
* `spec/framework/11-spec-authority-and-version-policy.md`
* `spec/framework/12-matrix-protocol-compliance-profile.md`
* `spec/framework/13-cloudflare-platform-constraint-register.md`
* `spec/framework/14-traceability-and-change-control.md`
* `spec/framework/15-source-observation-register.md`

Usage:

* defines scope, authority, profile, traceability, pinned baselines, and platform facts

### Layer 2: Architecture And Contracts

Files:

* `spec/framework/20-system-context-and-principles.md`
* `spec/framework/21-runtime-topology-and-platform-model.md`
* `spec/framework/22-data-consistency-and-routing.md`
* `spec/framework/23-interface-contract-catalog.md`
* `spec/framework/24-data-contract-catalog.md`
* `spec/framework/25-sequence-and-state-machine-catalog.md`
* `spec/framework/26-wire-schema-catalog.md`

Usage:

* defines runtime ownership, storage boundaries, interfaces, data contracts, flows, and wire shapes

### Layer 3: Domain Behavior

Files:

* `spec/framework/30-client-identity-and-sync.md`
* `spec/framework/31-room-processing-and-room-versions.md`
* `spec/framework/32-federation.md`
* `spec/framework/33-media.md`
* `spec/framework/34-search-directory-and-appservices.md`

Usage:

* defines protocol-domain behavior

### Layer 4: Hardening, Delivery, Verification

Files:

* `spec/framework/40-security-and-abuse-resistance.md`
* `spec/framework/41-observability-performance-and-cost.md`
* `spec/framework/42-deployment-migration-and-recovery.md`
* `spec/framework/43-testing-and-compliance.md`
* `spec/framework/44-verification-and-evidence-register.md`

Usage:

* defines security guardrails, deployment rules, recovery rules, test gates, and evidence closure

### Layer 5: Decisions And Open Questions

Files:

* `spec/decisions/*.md`
* `spec/open-questions/*.md`

Usage:

* resolves conflicts, freezes product boundaries, and records unresolved issues

## Spec Readiness Levels For Development

These levels are an execution policy for AI agents. They do not replace the repo's `L0-L3` release profiles.

### `SR0` Research-Only

Condition:

* facts exist only in `research/` / `notes/` / historical draft

Agent action:

* do not write production code
* first promote facts into the Spec system

### `SR1` Scope-Defined

Condition:

* owning spec is known
* relevant `MX-*` / `CF-*` / `REQ-*` boundaries are defined
* but contracts/data/flows are still incomplete

Agent action:

* Spec work only
* no full implementation yet

### `SR2` Contract-Ready

Condition:

* owning spec exists
* required `REQ-*`, `MX-*`, `CF-*`, `IF-*`, `DATA-*`, and required `FLOW-*` / `STATE-*` are defined
* runtime owner is unambiguous

Agent action:

* code implementation may begin
* implementation must follow existing contracts exactly

### `SR3` Verification-Ready

Condition:

* feature also has mapped `TEST-*` and `EVID-*`
* release-profile expectation is clear

Agent action:

* implement, verify, debug, and prepare merge-ready change

If a task is below `SR2`, do Spec work first.

## Spec-First Development Rule

Before writing code for any feature or fix, identify all of the following:

* target release profile: `L1`, `L2`, or `L3`
* owning spec
* relevant `REQ-*`
* relevant `MX-*`
* relevant `CF-*`
* relevant `IF-*`
* relevant `DATA-*`
* relevant `FLOW-*` / `STATE-*`
* relevant `TEST-*`
* relevant `EVID-*`
* any applicable `DEC-*` / `OQ-*`
* the exact `TODO.md` item being executed

If you cannot map the work to that set, the task is not ready for implementation.

## Code Requirements

All future code in this repository must respect these core constraints.

### Runtime Ownership

Map code to the runtime model already fixed by Spec:

* `gateway-worker`: public Matrix ingress, routing, auth edge, long-poll holding, streaming
* `jobs-worker`: async derived work, rebuild, export, compensation
* `ops-worker`: protected operator control plane
* `UserDO`: user authority
* `RoomDO`: room authority
* `RemoteServerDO`: remote-server authority

Do not invent alternate authority owners without changing the Spec first.

### Authority And Storage

* authority truth belongs in DO SQLite
* D1 is for derived query plane and limited control-plane metadata
* KV is cache only
* R2 is for blobs, cold history, exports, and archives
* Queues are for async work, never authority commit

### Critical Architectural Invariants

Code must preserve at least these invariants already fixed in Spec:

* no authority write path may wait on external I/O before commit
* `/sync` long-poll is held by `gateway-worker`, not by `UserDO`
* room event admission is serialized in `RoomDO`
* session/device/to-device/user stream state is serialized in `UserDO`
* federation outbound ordering and retry are serialized in `RemoteServerDO`
* internal Worker/DO contracts must remain backward compatible across version skew

### Contract Discipline

* public routes must implement `IF-*` contracts exactly
* internal RPC must use named fields, not position-sensitive tuples
* wire shapes must match Matrix `v1.17` or local `26-wire-schema-catalog.md`
* unsupported or stubbed routes must return the deterministic contract required by Spec

### Product-Boundary Discipline

If a surface is marked:

* `Stub-Only`: implement only the fixed stub truth
* `Deferred`: do not claim support
* `Unsupported`: reject deterministically

Do not “partially enable” these surfaces in code.

## Required Read Order For Any Implementation Task

For any new feature, fix, or refactor, read in this order:

1. `spec/framework/README.md`
2. `spec/framework/11-spec-authority-and-version-policy.md`
3. `spec/framework/12-matrix-protocol-compliance-profile.md`
4. `spec/framework/13-cloudflare-platform-constraint-register.md`
5. `spec/framework/14-traceability-and-change-control.md`
6. owning domain spec in `30-34` or control spec in `40-42`
7. `spec/framework/23-interface-contract-catalog.md`
8. `spec/framework/24-data-contract-catalog.md`
9. `spec/framework/25-sequence-and-state-machine-catalog.md`
10. `spec/framework/26-wire-schema-catalog.md`
11. `spec/framework/43-testing-and-compliance.md`
12. `spec/framework/44-verification-and-evidence-register.md`
13. related `DEC-*` / `OQ-*`
14. the relevant section in `TODO.md`

## Development Workflow

### 1. Intake

Determine:

* what behavior is being added, changed, or fixed
* which release profile it belongs to
* whether the task is Spec work, code work, test work, or debug work
* which exact `TODO.md` item owns the work

### 2. Spec Closure Check

Confirm the work is at least `SR2`.

If not:

* add or update the owning spec
* add missing contracts/data/flows/states
* add `DEC-*` or `OQ-*` if the issue is unresolved
* update `TODO.md` so the missing prerequisite is explicit

### 3. Implementation Slice Plan

Break the work into a vertical slice:

* route or RPC entry
* authority owner
* data contracts touched
* derived side effects
* tests to prove behavior

Avoid large speculative scaffolds.

### 4. Implement

Implement only what the Spec currently authorizes.

When bootstrapping a new codebase area:

* create the minimal real toolchain needed
* keep structure aligned to runtime ownership and contract boundaries
* do not add packages, frameworks, or infra just because they are familiar
* prefer the suggested layout in `TODO.md` unless the repository has already converged on another Spec-aligned layout

### 5. Verify

Verification is mandatory, not optional.

At minimum:

* run the actual project checks that exist
* add or update tests mapped to the relevant `TEST-*`
* confirm behavior matches the relevant `IF-*`, `DATA-*`, and `FLOW-*`

If there is no toolchain yet, create the smallest honest validation path instead of inventing a fake one.

### 6. Close The Loop

If verification fails, classify the failure:

* Spec wrong
* code wrong
* test wrong
* platform assumption wrong
* unresolved product-boundary issue

Then update the correct artifact:

* Spec file
* code
* test
* `DEC-*`
* `OQ-*`
* source observation register
* `TODO.md`

## Research -> Development -> Verification -> Debug Loop

Use this loop continuously:

1. Research
   Only official Matrix and Cloudflare facts count.
2. Spec
   Convert facts into `REQ/MX/CF/IF/DATA/FLOW/STATE/TEST/EVID/DEC/OQ`.
3. Development
   Implement only from the Spec.
4. Verification
   Test behavior against release-profile expectations.
5. Debug
   Feed mismatches back into Spec or code.
6. Repeat

The loop is not complete until the mismatch is explained and the correct artifact is updated.

## Definition Of Done For AI Changes

A development task is not done when code compiles. It is done when:

* the change is traceable to the owning Spec
* the corresponding `TODO.md` item has been updated honestly
* implementation respects runtime ownership and storage boundaries
* relevant tests exist or are updated
* unsupported/stub-only boundaries remain correct
* any newly discovered ambiguity is captured as `DEC-*` or `OQ-*`
* any claimed profile impact is honest

## Practical Rules For A Spec-Heavy Repository

Today this repository is still mostly documentation. Therefore:

* do not assume an existing app layout
* do not assume `npm`, `pnpm`, `pytest`, `make`, or CI scripts already exist
* discover real tooling before using it
* if bootstrapping new code, keep it small, explicit, and aligned to the Spec stack
* keep `TODO.md` current; it is the execution memory for the Development phase

If future subdirectories gain their own `AGENTS.md`, the closer file should refine or override this root guidance for that subtree.
