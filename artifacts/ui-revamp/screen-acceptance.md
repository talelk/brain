# UI revamp screen acceptance

Status values are **passed / failed / not-run**. A production build is not browser acceptance. All final route screenshots were manually reviewed in `review/`; no visual snapshot was auto-approved. Behavior entries name the scenarios actually exercised. “Passed” in a viewport column means the real Governor-backed route rendered in both themes, had no uncaught page error, passed page-level horizontal-containment checks, and was visually reviewed.

## Matrix

| # | Screen | Before/after implementation notes | 390 light/dark | 768 light/dark | 1440 light/dark | Behavior / edge states | Evidence |
|---|---|---|---|---|---|---|---|
| 01 | Today | Uniform rows → prioritized inbox, filters and contextual preview | passed | passed | passed | passed: empty, loading, stale, 403, retry; exact-source navigation | `screenshots/*/01-today.png` |
| 02 | Bridge | Sparse card → action-sorted multi-workspace control grid | passed | passed | passed | passed: real workspace summaries and workspace links | `screenshots/*/02-bridge.png` |
| 03 | Workspace overview | Isolated counters → operational landing and context rail | passed | passed | passed | passed: readiness, blockers, active run and Work links | `screenshots/*/03-workspace-overview.png` |
| 04 | Board | Fixed lanes → fitted board with responsive detail | passed | passed | passed | passed: moves, drag/keyboard, expected-version conflict, Done denied without and allowed with verified evidence | `screenshots/*/04-board.png`; `board.spec.ts`; `authority-edge.spec.ts` |
| 05 | Plans | Stacked form/blank pane → three-stage planning studio | passed | passed | passed | passed: proposal, explicit confirmation, replan history | `screenshots/*/05-plans.png`; `plans.spec.ts` |
| 06 | Schedules | Giant form → library and guided editor | passed | passed | passed | passed: typed validation, offline wait/recovery/fail receipts | `screenshots/*/06-schedules.png`; `schedules.spec.ts` |
| 07 | Resources | Form/list stack → upload library, search and safe preview | passed | passed | passed | passed: upload, revise, associate, search, revoke, safe raw preview | `screenshots/*/07-resources.png`; `resources.spec.ts` |
| 08 | Start work | Narrow catalog/empty pane → launch studio with three modes | passed | passed | passed | passed: shared review, timeout recovery without duplicate run, work-item linkage | `screenshots/*/08-start-work.png`; `task-entry.spec.ts` |
| 09 | Activity | Generic counters/table → execution control center | passed | passed | passed | passed: real runs, scoped filters, detail navigation and bounded controls | `screenshots/*/09-activity.png`; `operational.spec.ts` |
| 10 | Run detail | Tabbed cards → mission-control status, output, evidence and context | passed | passed | passed | passed: real execution/evidence; unknown outcome offers reconciliation only and stays unknown pending proof | `screenshots/*/10-run-detail.png`; `authority-edge.spec.ts` |
| 11 | Agents | Tiny table → capability catalog and definition detail | passed | passed | passed | passed: actual release definitions, trust/scope and related workflows; no session conflation | `screenshots/*/11-agents.png` |
| 12 | Support | Table → triage queue with selected preview | passed | passed | passed | passed: direct mobile/detail and desktop preview/casework routes; real partial SLA failure | `screenshots/*/12-support.png`; `kiosk.spec.ts`; `ui-accessibility.spec.ts` |
| 13 | Ticket detail | Stacked artifacts → staged casework and side context | passed | passed | passed | passed: exact source record; draft, approval and publication remain separate | `screenshots/*/13-ticket-detail.png`; `kiosk.spec.ts` |
| 14 | Incidents | Unstructured rows → severity/freshness operations queue | passed | passed | passed | passed: authorized empty and populated observed incident states | `screenshots/*/14-incidents.png`; `work.spec.ts` |
| 15 | Incident detail | Static cards → investigation timeline and diagnosis/remediation boundary | passed | passed | passed | passed: real target/freshness and intentional missing-artifact state | `screenshots/*/15-incident-detail.png` |
| 16 | Delivery | Stranded dossier → readiness cockpit | passed | passed | passed | passed: dossier/criteria reads and separate business decision controls | `screenshots/*/16-delivery.png`; `work.spec.ts` |
| 17 | Knowledge | Stacked studio/search → scoped knowledge journeys | passed | passed | passed | passed: scoped search, verified capitalization and governed promotion | `screenshots/*/17-knowledge.png`; `capitalization.spec.ts` |
| 18 | Tools | Registry table → trusted capability registry and detail | passed | passed | passed | passed: real declarations/evidence; proposal/publication remain governed | `screenshots/*/18-tools.png`; `capitalization.spec.ts` |
| 19 | Runners | Activity reuse → dedicated execution fleet | passed | passed | passed | passed: online + draining + reserved-slot axes and assignment explanation | `screenshots/*/19-runners.png`; `authority-edge.spec.ts` |
| 20 | Runner detail | Capacity cards → diagnostic console and operational rail | passed | passed | passed | passed: reason-required drain/quarantine with server-confirmed state | `screenshots/*/20-runner-detail.png`; `operations.spec.ts` |
| 21 | Approvals | Narrow table → prioritized decision inbox and preview | passed | passed | passed | passed: one-at-a-time review, filters, no bulk production approval | `screenshots/*/21-approvals.png`; `approval.spec.ts` |
| 22 | Approval detail | JSON-first → human impact review and exact decision rail | passed | passed | passed | passed: TOTP, stale version/note preservation, timeout replay, expiry denial, offline denial | `screenshots/*/22-approval-detail.png`; `approval*.spec.ts`; `authority-edge.spec.ts`; `offline.spec.ts` |
| 23 | Decisions | Table → append-only decision register and composer | passed | passed | passed | passed: rationale, provenance and business/effect separation | `screenshots/*/23-decisions.png`; `work.spec.ts` |
| 24 | Settings / Setup | Repeated checklist → readiness journey and owning-flow actions | passed | passed | passed | passed: missing gates and real local model/runner setup | `screenshots/*/24-settings-setup.png`; `model-setup.spec.ts` |
| 25 | Settings / Security | Long forms → account security center | passed | passed | passed | passed: authenticator enrollment, second-factor sign-in and passkey registration | `screenshots/*/25-settings-security.png`; `authentication.spec.ts`; `identity-administration.spec.ts` |
| 26 | Settings / Integrations | Form-first → connection management and guided remote creation | passed | passed | passed | passed: real connect/verify/bind and ref proposal flow | `screenshots/*/26-settings-integrations.png`; `integrations.spec.ts` |
| 27 | Settings / Release | Digest-led form → release readiness and candidate inspection | passed | passed | passed | passed: inspect then separately activate exact release | `screenshots/*/27-settings-release.png`; `operational.spec.ts` |
| 28 | Settings / Members | Access table → people/access management | passed | passed | passed | passed: real grant/revoke; expected-version conflict UI not separately run | `screenshots/*/28-settings-members.png`; `identity-administration.spec.ts` |
| 29 | Settings / Invitations | Empty table → invitation lifecycle and supported empty state | passed | passed | passed | passed: native invite, verification, acceptance and workspace access | `screenshots/*/29-settings-invitations.png`; `identity-administration.spec.ts` |
| 30 | Settings / Policy | Key/value grid → grouped effective posture and provenance | passed | passed | passed | passed: read-only effective policy; no bypass controls | `screenshots/*/30-settings-policy.png`; `operational.spec.ts` |
| 31 | Session detail | Thin log → live grouped agent activity and context | passed | passed | passed | passed: 10,000-event replay, bounded DOM, preserved selection/scroll and live burst | `screenshots/*/31-session-detail.png`; `sse-logviewer.spec.ts` |
| 32 | Settings / Health | Health/audit table → operations status and audit timeline | passed | passed | passed | passed: service freshness, unsupported state and redacted diagnostics download | `screenshots/*/32-settings-health.png`; `task-entry.spec.ts` |
| 33 | TV Support | Scaled web table → redacted distance-readable support wallboard | passed (+1920) | passed (+1920) | passed (+1920) | passed: read-only kiosk, no shell/actions, freshness and redacted exceptions | `screenshots/*/33-tv-support*.png`; `kiosk.spec.ts` |
| 34 | TV SRE | Small incident cards → glanceable critical-observation wallboard | passed (+1920) | passed (+1920) | passed (+1920) | passed: observed incident and explicit no-incident state; no false universal health | `screenshots/*/34-tv-sre*.png`; `ui-accessibility.spec.ts` |

## Cross-screen verification register

| Check | Status | Evidence / notes |
|---|---|---|
| Baseline typecheck + production build | passed | 75.30 KiB gzip initial index; 34.27 KiB gzip CSS |
| Baseline browser coverage | passed | 162 unique browser tests passed across the initial timed-out run and completed remainder |
| Final typecheck, lint, Biome and knip | passed | Final chained validation command; build also repeats server/web typechecks |
| Final full Playwright matrix | passed | **216 passed**, zero failed: 36 scenarios in each of 390/768/1440 light/dark projects, including 10k replay |
| New screenshots for every screen/theme/viewport | passed | 34 screens × six projects; 1920×1080 TV images; manual contact-sheet/full-size review |
| Keyboard-only and dialog focus restore | passed | `navigation.spec.ts`; keyboard workspace/create and controls in `ui-accessibility.spec.ts` |
| Reduced motion | passed | Computed animation duration ≤0.00001s in all six projects |
| 200% zoom | passed | Today and representative Work/Approvals/TV containment in all six projects |
| Long French input | passed | Real search value preserved; no fabricated localized business data |
| RTL containment | passed | Representative shell, catalog, approvals and TV routes; screenshots in `accessibility/` |
| Loading / empty / no-access / stale / partial / retry / offline | passed | Real delayed, 403 and 500 responses plus offline PWA behavior |
| Submit once + timeout recovery | passed | Existing reviewed draft recovers its one run; no duplicate dispatch |
| Approval stale + step-up + replay + offline denial | passed | Real 409 state, TOTP, committed/lost response recovery, expired session and offline mutation denial |
| Unknown effect reconcile, no Retry | passed | Pending reconciliation request recorded; run remains `outcome_unknown` until evidence |
| Board expectedVersion conflict + verified Done | passed | Intent preserved; no state change on conflict; independent evidence required |
| Runner busy allocation + draining + quarantine acknowledgement | passed | Independent state axes and reason-bound server-confirmed operations |
| Workspace revocation clears private content | passed | Protected board title removed; no-workspace setup replaces private content |
| 10k-event bounded feed + selection/scroll | passed | Full replay and 40-event live burst; mounted DOM remains below 150 rows |
| Today LCP target <2500ms (lab) | passed | 100–128ms across six projects; structured results in `performance/report.json` |
| INP ≤200ms target (lab observer) | passed | Observed maximum 0ms across six projects; not a field-real-user measurement |
| Initial Today JS ≤250 KiB | passed | 212,593 network-encoded bytes in browser; production initial index 75.15 KiB gzip |
| Final CSS bundle | passed | 37.33 KiB gzip |
| Representative-user feedback | not-run | No human usability session has been performed |

## Evidence commands

- `pnpm build && pnpm typecheck:browser && pnpm check:static`
- `pnpm test:browser` (216 checks: 36 scenarios across each of six projects)
- `playwright test tests/browser/ui-accessibility.spec.ts tests/browser/vitals.spec.ts --reporter=json` (24 checks; saved as `performance/report.json`)

The browser matrix and performance measurements are separate evidence categories from the visual review. No production business data was fabricated; populated captures use isolated Governor fixtures.
