# 15 — Requirements, source parity and explicit deferrals

## Original v4 acceptance mapping

| Source AC | Required implementation scenario(s) | Primary task(s) |
|---|---|---|
| AC-01 workflow reproducibility/restart | E014/E015/E022/E026 | T10/T11/T29/T30 |
| AC-02 invalid config/graph | E011–E020 | T08–T10 |
| AC-03 writer conflict | E031/E043/E044/E059 | T14/T17/T18 |
| AC-04 100 pending approvals/restart | E022/E023 | T30 |
| AC-05 human approve/agent replay | E004/E053/E054 | T13/T14/T32 |
| AC-06 target/diff changed | E051/E058 | T13/T23 |
| AC-07 crash after production call | E056/E057 | T18/T23/T46 |
| AC-08 stale fence | E038/E042 | T18 |
| AC-09 worktrees/merge | E058/E059/E065/E071 | T21/T23/T24 |
| AC-10 Pi/Claude parity | E062 | T24/T25 |
| AC-11 unsupported ACP/steer | E061/E100 | T26/T36 |
| AC-12 channel-equivalent denial | E001–E005/E066/E067 | T06/T12/T22/T32 |
| AC-13/14 three independent successes, not retries | E076/E077 | T40 |
| AC-15 candidate self-escalation | E013/E033/E066 | T09/T12/T40 |
| AC-16 cross-workspace TencentDB denial | E078 | T38/T39 |
| AC-17 memory down during approval | E079/E095 | T35/T39 |
| AC-18 export/clean restore | E081/E088/E089 | T47 |
| AC-19 reviewed global skill | E080 | T39 |
| AC-20 cache permission revoke | E003/E078 | T12/T39 |
| AC-21 config change mid-run | E015/E021/E026 | T11/T30 |
| AC-22 control disk/corruption | E087 | T04/T48 |
| AC-23 sandbox host/secret denial | E065–E067 | T21/T23 |
| AC-24 house/work progress | E047/E048/E049 | T19/T49 |
| AC-25 retained disabled packages | E026/E100 | T11/T30/T50 |
| AC-26 outbox duplicate | E085/E086 | T07 |

## Runner amendment mapping

| RFC-041 requirement | Contract / implementation | Verification |
|---|---|---|
| Outbound registered resources, one slot default | RunnerHello/Session, supervisor | E010/E038/E040 |
| Five capability dimensions plus numeric capacity | CapabilityObservation/Placement/Resources | E032–E035 |
| Group/label/engine/isolation hard filters | Placement predicate and explain snapshot | E033–E035/E048 |
| Lease/epoch/resource fences | AttemptIdentity, JobOffer, ResourceFence | E031/E036–E044 |
| General agents separate from privileged tools | Group trust, sandbox, effect permits | E055/E065–E067 |
| Human wait releases slots | Gate bridge and new scheduling after approval | E022/E023/E036 |
| Drain/quarantine | Administrative state and revocation | E045/E046 |
| Unknown effects don't blindly retry | Effect ledger/reconciler | E044/E056/E057 |
| Harness independence | Engine port and conformance | E061–E064 |
| Global ownership/workspace portability | Outbox and restore manifests | E085/E088/E089 |

## Presentation behavior retained

| Presentation pages | Behavior | Decision for new product |
|---|---|---|
| 3–6 | Morning briefing, Today and multi-workspace Bridge | T34; prioritized facts/actions, configurable timezone and notification |
| 7–10 | SRE, support, SLA and exact approvals | T35/T42/T43; read-only investigation and governed publication/remediation |
| 11–12 | Decisions, boards and live sessions | T31/T36/T37; verbatim decisions, verified Done and honest capabilities |
| 13–14, 38 | Runner lanes/capabilities and keeper | T19/T20/T46; fair house/work and owned-file reconciliation |
| 15–17 | TV, mobile alerts and platform health | T45/T48; scoped kiosk, PWA fallback and measured service health |
| 18 onward | Knowledge, onboarding, roles/director/workspace specialists | T24/T38–T41; declarative roles and bounded delegation, source evidence |
| 39–40 | Exact action/target approval, injection and self-modification controls | T12–T14/T21–T23; server identity/ledger replaces text-block trust |
| 41–44 | Support/SRE/Delivery/Eval and generic business workspaces | T41–T44; extensible packs and connectors, no client-specific core constants |
| 46/50 | Earlier Helm/HA/Planka/MinIO/Qdrant topology | Explicitly superseded by v4 single Governor/Compose/native board/CAS/TencentDB |
| 48–52 | Historical deployment counts, cost and quality measurements | Context only, not new-product performance evidence or acceptance results |

The presentation's unauthenticated TV wording becomes a scoped kiosk identity. Android biometric-keystore/widgets are deferred native-client features; PWA does not promise them. Generic business roles can use the same contracts, but SharePoint/CRM/ERP connectors are separate future packs with their own validation.

## User-selected UI foundation

NewUI is required for Web/PWA/TV presentation. Documents 01/09/10/12/13 and document 16 implement this choice across module ownership, component reuse, styling, performance and verification. Historical `@newui/ui` paths and the original custom primitive/token proposal are superseded by the reviewed `@talelk/newui-*` public package graph. Transport/authorization contracts remain Brain-owned; NewUI does not introduce Frappe as a backend dependency.

## Deferred until justified

The user's direct-target instruction excludes backward/forward compatibility, historical migration, old/new runtime coexistence and incremental delivery constraints until explicit new direction. Task/source traceability does not reinstate those obligations. AC-25/E026 cover same-build immutable definitions and evidence; E100 validates target mismatch rejection rather than upgrades. Fresh current-schema setup and current-format backup/restart/restore remain required. See [the implementation prompt](../../IMPLEMENTATION_PROMPT.md).

Active-active control, PostgreSQL migration, arbitrary GUI workflow authoring, platform-global cross-customer knowledge, autonomous production remediation, dynamic converge loops, untrusted plugin installation, native Android parity, local model serving, Rust supervisor, Victoria stack, duplicate model eval frameworks and same-file Brain/Mastra storage are deferred. No placeholder implementation should imply they work.

## Contract completeness boundary

This pack defines shared foundational transport/config/runner/approval/evidence/knowledge contracts, typed baseline read models and reference persistence invariants. Runtime-specific vendor table schemas and authentication flows remain owned by pinned vendor packages. Lifecycle event payloads carry typed resource/version references; clients read detailed content through authorized queries/artifacts. Connector-specific remote payloads, new business packs and new operations require a versioned feature contract before shipping; a JSON envelope is not permission to bypass validation.

Implementation readiness means a bounded next task can be executed without inventing architecture. Production readiness additionally requires G01–G08, runtime scenarios, measured performance and independent review. “All edge cases” is operationalized by E001–E100 plus mandatory additions when a new failure mode is discovered; it is not a promise that no undiscovered failure exists.
