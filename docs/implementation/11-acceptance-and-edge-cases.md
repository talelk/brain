# 11 — Acceptance, negative cases and fault testing

## Evidence levels

`PACK` checks run in this repository: schema/fixture validity, generated DTO freshness/typecheck, local links, SQL syntax/selected constraints and example Bash behavior. `DOMAIN`, `INTEGRATION`, `SECURITY`, `CHAOS`, `BROWSER`, `PERF` are future implementation suites. A green PACK result does not satisfy a runtime scenario. All runtime scenarios below start pending; tasks name the suite file that must implement them.

Tests use deterministic clocks/IDs and fresh per-test DBs/checkouts. Security tests use independent denied-path oracles; do not assert only that a mocked authorization method was called. Chaos tests kill real owned processes at named persistence boundaries. Browser tests use real command handlers against isolated fixture services and preserve artifacts. Model-quality experiments use sanitized fixed datasets with costs and uncertainty reported separately.

## Scenario inventory

| ID | Scenario / edge case | Required result | Suite |
|---|---|---|---|
| E001 | Client submits a human ActorContext | Rejected/ignored as identity; authenticated principal remains authority | SECURITY |
| E002 | Workspace A IDs used by tenant B | 404/no data, no mutation or cache leakage | SECURITY |
| E003 | Revoked user keeps browser/SSE session open | New operations denied; stream/access data cleared | SECURITY/BROWSER |
| E004 | Agent tries approval endpoint or MCP forged human note | No decision accepted | SECURITY |
| E005 | Cookie-authenticated cross-origin mutation | CSRF/origin rejection | SECURITY |
| E006 | Same idempotency key and same payload after timeout | One resource and saved receipt | INTEGRATION |
| E007 | Same key with changed payload/workspace/version | Conflict, no second mutation | INTEGRATION |
| E008 | Different actors reuse a key | Separate namespaces and no receipt disclosure | SECURITY |
| E009 | Expected board version is stale | Conflict, current version visible, no overwrite | DOMAIN/BROWSER |
| E010 | Bootstrap/enrollment token replay | One identity only; expired/replayed token denied | SECURITY |
| E011 | YAML duplicate/unknown key, alias, tag, multi-document | Fail with exact source diagnostic | DOMAIN |
| E012 | Config symlink/path traversal/case collision | Fail confined loader, no host file access | SECURITY |
| E013 | Override broadens floor/uses null to disable safeguard | Reject; active config unchanged | DOMAIN |
| E014 | Same config with different map order | Same canonical release digest | DOMAIN |
| E015 | Changed tool script/schema/mode bit | New release digest; active run keeps prior pin | DOMAIN |
| E016 | Missing dependency/cycle/unreachable binding | Compile failure with job/path | DOMAIN |
| E017 | Binding points to future/unneeded job or missing field | Reject static unresolved path or runtime output; no empty substitution | DOMAIN |
| E018 | Dangerous schema/network ref/regex complexity | Reject before activation; no schema SSRF | SECURITY |
| E019 | Gate exists on one branch but does not dominate effect | Reject graph; runtime still exact-checks | DOMAIN |
| E020 | Root jobs/old spec.nodes used | Unsupported-contract diagnostic; no converter or alternate runtime grammar | DOMAIN |
| E021 | Config activation races another release | CAS conflict; one pointer update | INTEGRATION |
| E022 | Mastra restarts with 100 pending gates | All waits restored; zero duplicate dispatch/effect | INTEGRATION/CHAOS |
| E023 | Approval arrives before engine snapshot | Wake intent retained and eventually applied once | CHAOS |
| E024 | Duplicate wake or old wait generation | No duplicate execution; old wait ignored/rejected | INTEGRATION |
| E025 | Mastra registration/snapshot commit fails | Run blocked and reconcilable, not guessed success | CHAOS |
| E026 | Current-build configuration disables a primitive referenced by a suspended run | Preserve pinned current-build definition/evidence or explicitly cancel; no historical code retention/conversion | INTEGRATION |
| E027 | Nested subgraph recursion/depth excess | Compilation/dispatch bounded and rejected | DOMAIN |
| E028 | Cancel before delayed workspace create/start | Tombstone prevents resurrection | CHAOS |
| E029 | Retry limit or workflow deadline reached | Stable blocked/failed result with evidence; no loop | DOMAIN |
| E030 | DST skipped/repeated hour and cron backlog | Declared misfire policy, unique fire identity, bounded catch-up | DOMAIN |
| E031 | Two runners claim same queued job | One offer and one active attempt | INTEGRATION |
| E032 | Concurrent jobs exceed CPU/RAM/disk/slots | Atomic reservations prevent oversubscription | INTEGRATION |
| E033 | Runner advertises privileged group/capability | Cannot elevate registered trust or target permission | SECURITY |
| E034 | Capability/connectivity observation expires | Ineligible with accurate explain reason | DOMAIN |
| E035 | No matching runner versus no capacity versus policy deny | Distinct queue reason, no cross-tenant inventory leak | DOMAIN/BROWSER |
| E036 | Offer times out without ACK | Release owned reservation, no consumed approval | CHAOS |
| E037 | Duplicate ACK/renew/completion | Same saved result; changed receipt conflicts | INTEGRATION |
| E038 | New hello epoch while old process still runs | Old session fenced; process/effect reconciled | CHAOS |
| E039 | Heartbeat reorder, duplicate, same sequence changed body | Monotonic acceptance or protocol violation | INTEGRATION |
| E040 | Runner capacity/free slots is zero | Valid observation, no new admission | DOMAIN |
| E041 | Runner disconnect beyond lease | Local stop, global suspect state, no blind write retry | CHAOS |
| E042 | Stale lease/job fence reports success | Cannot finalize; late evidence quarantined | SECURITY |
| E043 | Resource counter after lease deletion/reacquisition | Strictly increases; never reset | INTEGRATION |
| E044 | Expired lease but unresolved target mutation | Conflict guard remains, competing effect blocked | CHAOS |
| E045 | Draining busy runner | No new claims, owned work allowed bounded finish | INTEGRATION/BROWSER |
| E046 | Quarantine during an active job | Credentials/permits revoked, stop recorded, outcome reconciled | SECURITY/CHAOS |
| E047 | Long build and house task compete | Reserved house progress and no starvation | PERF |
| E048 | Malicious high priority workspace | Bounded priority/fairness; other workspace progresses | PERF |
| E049 | More candidates than claim page limit | Fair cursor eventually finds eligible job | PERF |
| E050 | Counter overflow/time jumps | Stop allocation/permits, explicit operator health error | DOMAIN/CHAOS |
| E051 | Approval target/text/diff/tool/policy digest changes | New approval required | SECURITY |
| E052 | Approval expires in queue or before tool effect | Permit denied, no mutation | INTEGRATION |
| E053 | Two permits consume one approval concurrently | Exactly one immutable consumption/invocation | INTEGRATION |
| E054 | Permit committed but response lost | Same invocation returns original permit, no second consumption | CHAOS |
| E055 | Cancel/revoke between proposal and effect | Broker checks current permit; stops before effect where enforceable | SECURITY |
| E056 | Crash after target mutation before receipt | Outcome unknown/readback, no generic retry | CHAOS |
| E057 | Target supports no CAS/idempotency/queryable receipt | Conservative serialized operation and explicit uncertainty | INTEGRATION |
| E058 | External branch/resource changes after preflight | Target precondition fails; no expanded operation | INTEGRATION |
| E059 | Two workspaces alias same physical target | Same canonical conflict key | SECURITY |
| E060 | Human approves own high-risk authored change | Separation-of-duties policy enforced | SECURITY |
| E061 | Harness unsupported steer/resume/fork | Structured unsupported response and honest UI controls | INTEGRATION/BROWSER |
| E062 | Pi/Claude same synthetic task | Same structured outcome/evidence acceptance | INTEGRATION |
| E063 | Malformed/truncated/duplicate harness event | Adapter contains error, retains diagnostics and bounded stream | INTEGRATION |
| E064 | Provider rate limit/timeout/auth failure | Classified bounded behavior and usage uncertainty | INTEGRATION |
| E065 | Agent subprocess daemonizes/ignores TERM/forks | Owned cgroup/VM killed; slot not reused before proof | SECURITY |
| E066 | Tool shell injection, flags, Git hooks/config | Fixed argv/resource loader and denied bypass | SECURITY |
| E067 | Sandbox probes host secret/Docker socket/metadata network | Kernel/network denial, no host access | SECURITY |
| E068 | Tool exit 0 with invalid JSON/schema or oversized output | Failed evidence; bounded bytes, no Done | INTEGRATION |
| E069 | Tool exit nonzero after observed mutation | Partial/unknown, no safe-read retry path | INTEGRATION |
| E070 | Budget oversubscription across parent/children | Atomic reservations; depth/turn/cost limits stop new work | INTEGRATION |
| E071 | Context compaction/fallback after dirty code change | Verified checkpoint, new attempt, no file ownership loss | INTEGRATION |
| E072 | Runner spool full or slow consumer | Backpressure/bounded stop, durable effect events retained | CHAOS/PERF |
| E073 | Author tries to submit its own verdict/change golden tests | Rejected by evaluator identity and immutable fixtures | SECURITY |
| E074 | Evidence artifact absent/changed/partially uploaded | No verified verdict/Done | INTEGRATION |
| E075 | Same evidence with changed verdict/check digest | Immutable conflict/new bundle, no silent overwrite | INTEGRATION |
| E076 | Three retries versus three independent successful operations | Only distinct verified originals count; one candidate | DOMAIN |
| E077 | Two concurrent third observations | One unique quarantined candidate | INTEGRATION |
| E078 | Memory scoped incorrectly/cached ACL revoked | Deny including caches and direct asset lookup | SECURITY |
| E079 | TencentDB down/FTS5 missing/index pending | Explicit degraded state, no false empty-success guarantee | INTEGRATION |
| E080 | Memory injection/secret promotion/cross-org global sharing | Advisory only; scrub/review/authorization gate | SECURITY |
| E081 | Upstream memory export lacks Wiki/index components | Partial manifest with named omissions | INTEGRATION |
| E082 | Duplicate/out-of-order webhook/poll result | One observation, gap recovery and cursor correctness | INTEGRATION |
| E083 | Support draft changed after review/missing-evidence request repeats | Fresh exact approval; one request per signature | INTEGRATION |
| E084 | SLA reopen, DST, responsibility pause, late correction | Deterministic interval/calendar recomputation | DOMAIN |
| E085 | Global commit before workspace outage / duplicate delivery | Durable queued receipt and one projection after recovery | CHAOS |
| E086 | Event ID collision/different payload or aggregate gap | Quarantine/park and repair; no corrupt projection | SECURITY |
| E087 | Disk full/SQLITE_BUSY/corruption during claim/permit | No partial authority commit, fail closed, diagnostic | CHAOS |
| E088 | Snapshot copied without WAL/consistency watermark | Restore validation refuses incomplete claim | INTEGRATION |
| E089 | Restore suspended run and old approvals/runner credentials | History preserved, execution stays disabled until fresh authority | CHAOS |
| E090 | CAS GC races upload/live evidence/backup | Referenced bytes retained; incomplete upload never published | INTEGRATION |
| E091 | SSE reconnect/gap/retention expiry and changed filters | Correct replay/reset and authorized snapshot | BROWSER |
| E092 | Slow SSE/log viewer with long transcript | Bounded server/client memory, scroll selection preserved | PERF/BROWSER |
| E093 | NewUI AppShell desktop collapse/mobile drawer; list → detail → decision → Back | One navigation model, correct focus restoration, all tasks usable at 390/768/1440 | BROWSER |
| E094 | Approval becomes stale while page is open | Approve disabled/revalidated, note preserved | BROWSER |
| E095 | Decision committed but response times out | UI queries same key; one decision | BROWSER |
| E096 | Offline PWA/service-worker update/push denied | No offline approval, safe refresh and visible fallback | BROWSER |
| E097 | UIConfig/build/image binding; NewUI production CSS/theme, dialogs/board/chart, RTL/long labels and text zoom | Reject unknown foundation, manifest drift and unavailable default locale; correct public exports/styles, keyboard/focus/contrast/layout, no duplicate primitive system | DOMAIN/INTEGRATION/BROWSER |
| E098 | TV token tries mutation/private ticket read | Read-only redacted scope enforced | SECURITY |
| E099 | Declared workload and 10× history | Proposed p95/p99/resource budgets measured or honest lower limits | PERF |
| E100 | Runner/build/schema contract differs from the supported target | Refuse mismatched execution with diagnostics; no cross-version normalization or upgrade path | INTEGRATION |
| E101 | Natural-language objective produces an unreviewed agent plan | Plan and tasks remain inert until explicit review; confirmation creates the exact WorkItems and dependencies | INTEGRATION/BROWSER |
| E102 | Replan after executions and partial completion | New PlanVersion; unchanged work retained, changed work replaced, abandoned history and old execution links preserved | INTEGRATION |
| E103 | WorkItem dependency or Done attempted without accepted evidence | Transition denied; no automatic completion from model text; verified dependencies release Ready work | DOMAIN/INTEGRATION |
| E104 | Schedule pause/run-now/DST/misfire/overlap plus Governor restart and lost response | Preview is server-derived; one durable occurrence per identity, no duplicate run, complete history | DOMAIN/INTEGRATION/CHAOS/BROWSER |
| E105 | Personal host is offline for scheduled work | Explicit wait/fail policy; no silent managed fallback or fictional native resume | INTEGRATION |
| E106 | Agent delegates beyond scope/budget or writers share a worktree | Delegation narrowed/denied and bounded; isolated writes and independent review; parent/WorkItem links intact | SECURITY/INTEGRATION |
| E107 | Document uploaded, associated, indexed, revised or revoked across memberships | Immutable bytes/versions and safe preview; scoped associations/search; no automatic shared-memory publication | SECURITY/INTEGRATION/BROWSER |
| E108 | Git credentials, webhook replay and configuration/project repository binding | Secrets never leave backend; exact rights verified; replay deduplicated; repository classes and permissions stay separate | SECURITY/INTEGRATION |
| E109 | Studio draft validation, advanced YAML, diff, PR/MR, compile and activation | No direct active mutation; exact reviewed commit compiles; impacted references revalidate; explicit activation required | SECURITY/INTEGRATION/BROWSER |
| E110 | Autonomous capitalization finds duplicates and prepares executable candidates | L0–L2 idempotent and provenance-scoped; no shared or executable L3 promotion without required review/release | INTEGRATION/SECURITY/CHAOS |

## Required suite tiers

FAST: contracts, pure reducers/compiler and focused repository tests, target ≤2 minutes. CHANGE: affected integration/security/browser scenarios, target ≤10 minutes on the declared dev host. FULL: all deterministic integration/security/browser scenarios and short chaos. RELEASE: pinned vendor conformance, long chaos/restore, performance, optional calibrated model eval and reviewer evidence. These are future target commands, not scripts present in this documentation-only repository.

Tests should be selected by requirements and changed boundaries. Keep independent acceptance oracles; do not duplicate tests that merely restate implementation details. A feature addition identifies the scenario IDs it covers and any intentional retirement. No `only`, silent skipped security cases, or automatic visual snapshot update is accepted in release evidence. Retry-passed tests are recorded as instability, not converted into clean first-pass success.

Final release evidence includes revision/dirty-tree fingerprint, exact versions/images, selected/executed scenario IDs, skipped/unsupported scope, commands, raw logs, timing, artifact hashes, cleanup and reviewer identity. Required failures remain open even if a narrower suite is green. A blocked upstream feature can ship disabled only when its dependent UX and API clearly expose unavailability and no advertised requirement depends on it.
