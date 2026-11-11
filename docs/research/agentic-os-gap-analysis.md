# Agentic OS from usage history — mapping and gap analysis

Input: [agentic-os-usage-analysis.source.md](agentic-os-usage-analysis.source.md), a pasted
analysis of recurring work (30 use cases, 6 "missions", a proposed stack). It is
**product input, not a specification**. Authorities remain `GLOSSARY.md`, `docs/adr/`,
`contracts/v1/` and `docs/implementation/`.

Checked against: `GLOSSARY.md`, ADR-0001..0004, `docs/functional-spec.md`,
`docs/implementation/01`, `08`, `25`, `contracts/v1/dependency-baseline.json`, and
`examples/v1/starter-release`. Not checked: code under `apps/`, `work-plan.json` task
coverage, `scenario-catalog.json`.

## 1. Vocabulary mapping

| Source term | Brain term | Notes |
|---|---|---|
| "Mission" (one of 6) | **Play** | The source's six missions are reusable templates. A Brain **Mission** is one persistent intention, started from a Play. Say "play" for the six. |
| "Agent" (Tender Radar…) | Play + **team members** bound to agent definitions | In Brain an agent is a definition, not a product. |
| Mission persistence (`MEM`) | Mission, **mission brief**, **accepted decision** | Covered. |
| `Run` | **Run** | Same, but ADR-0004: a mission is never a run. |
| `Decision` (bid/no-bid) | **Decision** (go / no / not-now / need-more-data) | Direct fit. The source's HITL "bid/no-bid" is a Decision; "proposal submission" is an **Approval** (external effect). Do not merge them. |
| `Approval` | **Approval** | Fits; bound to one exact effect digest. |
| `Artifact` | **Output / output version** | Glossary: avoid "artifact" for the mission-attributed thing. |
| `Evaluation` | **Verdict** by an **independent evaluator** | See conflict C1. |
| `Evidence` (sources & claims) | no equivalent | **Name collision.** Brain *Evidence* is an immutable bundle judged by an evaluator. The source's evidence is research provenance (source, claim, verified/measured/inferred/hypothetical). Needs its own name if adopted. |
| `Hypothesis` | none | See gap G4. |
| `Signal` | none | See gap G1. |
| Critic / Skeptic | **Team member** (reviewer role) | Glossary: independent evaluator "Avoid: critic". See C1. |
| Orchestrator–workers | **Coordinator** + peer team members | ADR-0003: peers, not delegated children. |
| `MEM` / "compounding intelligence" | **Knowledge asset**, **memory publication**, **capitalization run** | Covered, with stricter rules (see C4). |
| `WATCH` | Play trigger / **automation** (UF-12), connector poll/webhook | Partly covered, see G1. |
| `HITL` | Approval, Decision, Attention item, Step-up | Covered. |

## 2. Conflicts (the source contradicts a current rule)

**C1 — The Skeptic is a critic, and LLM evaluators establish nothing.** Glossary: "An LLM judge
cannot establish success"; the evaluator is never a mission team member; doc 08: an LLM
judge is "a supplemental scored signal". The source's Evaluator–Optimizer loops for
slides, UX and specs, and its Skeptic as the gate, would break this if they decide
success. Fits only as: (a) a *reviewer team member* producing findings, which are claims
like a handoff's notes; (b) acceptance via deterministic oracles (schema, tests, hashes,
screenshots, a11y checks) or L3 human. Quality gates in source §7 (UX, "recruitment") need
re-expression as deterministic checks or explicit human assessment.

**C2 — Stack proposals collide with closed decisions.** NATS JetStream versus doc 01: no
internal broker or general event bus, and ADR-0004 (Governor owns events/timers). "TypeScript
state machines" versus the pinned Mastra runtime (ADR-0004). MinIO versus local CAS
(introduce only with a demonstrated need). DuckDB/Parquet versus the dependency baseline
(not present; see G3). Rust workers, Kubernetes: not in scope. Better-Auth is already
selected, so that line is consistent. **Verdict: ignore the source's §5 stack table.**

**C3 — `orchestrator-workers` pattern wording** can be read as delegation children
(ADR-0003 says do not). Use Coordinator + mission-scheduled peers; delegation limits
(depth ≤ 2, ≤ 4 child jobs) apply only to subagents inside a session.

**C4 — Capitalization.** The source wants evidence history and "verified insights" to compound
automatically. Brain: knowledge assets come only from verified history, never from member
notes, messages or transcripts; publication needs a reviewer who is not the publisher.
Research findings that are only claims cannot be capitalized until they have an
evidence-backed verdict.

**C5 — Manifest YAML (`agents/opportunity-to-offer.yaml`).** Brain's definitions are
digest-pinned release documents (Agents, Workflows, Policies, Tools, Evaluators). The
source's manifest has no equivalent file format and mixes trigger, plan shape and
policy. Do not add it as a parallel format; express the same thing as release YAML + a Play.

## 3. Gaps (the source asks for something Brain does not describe)

| # | Gap | Evidence in repo | Severity |
|---|---|---|---|
| G1 | **Source-watching connectors** (tender portals, OSS release/benchmark feeds, market sources) with change detection and dedupe across scans. | Connector port, polling overlap windows/dedupe and webhook inbox exist (doc 08); only Support/SRE packs consume them. No public-web/tender source connector. | Medium |
| G2 | **Packs for the source's missions.** Existing packs: Onboarding, Support, SRE, Delivery, Eval. Mapping: Operations→Reliability ≈ SRE (+ Support for #18); Requirements→Software ≈ core missions + Delivery; Eval pack ≈ benchmark/quality gates. **No pack** for Opportunity→Revenue, Research→Innovation, Data→Decision, Knowledge→Impact. | doc 08 packs table. Open question: are packs compiled Governor modules (doc 01 says "compiled") or release-defined Plays? New domains as modules is heavy. | High (decides option 3) |
| G3 | **Data analysis environment** (SQL over supplied data, verified reproducible queries). | No DuckDB/analytics tool or governed-tool recipe for it; SQLite only. Doable as a governed tool (`docs/howto/add-governed-tool.md`) without touching the baseline. | Medium |
| G4 | **Research provenance** (source → claim → verified/measured/inferred/hypothetical). | Onboarding pack classifies fact/assumption/unverified; no general claim-level model. Could be an output schema, not a new core type. | Medium |
| G5 | **Document and deck generation** (docx/pptx/infographics) as governed outputs. | No tool contract found. Output/versions exist. | Low-Med |
| G6 | **Cross-mission "Skeptic"** as a standard reviewer step in every Play. | Fits as a reusable team-member role + plan shape; not described. Must obey C1 and the revision cap. | Low |
| G7 | **Estimation / pricing / bid compliance** domain content. | Nothing; pure Play content. | Content only |

## 4. Already covered (no action)

Persistent missions and briefs; schedules, misfire/overlap policy; human-only approvals
bound to exact digest; Decision records with go/no/not-now/need-more-data; independence
levels L1–L3; budgets and autonomy policy; checkpoint recovery; knowledge asset lifecycle
and Rule of Three capability candidates; per-play wall-display views. The source's "typed
shared objects" and "control plane" are the existing design.

## 5. Recommendation

1. Adopt only vocabulary alignment (section 1) and the Skeptic as a reviewer role (G6, within C1).
2. Do not change architecture, stack or contracts based on this document.
3. The only decision with real cost is **G2**: how new domain Plays are delivered
   (release-defined Plays vs compiled packs). Resolve it before any prototype.
4. Opportunity→Revenue remains the best candidate for a first reference Play because it needs
   G1 (one connector), G7 (content) and G6, and little else. That is a decision for the
   follow-up, not this document.

## 6. Open questions

- Q1: Is a Play always release-defined content, or may it require a compiled pack module? (doc 01 vs functional spec). Evidence so far: `work-plan.json` plans compiled modules only for `packs/{support,sre,eval}` with Play views over pack-owned subjects (tickets, incidents). A new domain with no external subject (e.g. opportunities) may not need a pack at all. Not yet confirmed.
- Q2: Does `work-plan.json` cover G1–G5? A targeted grep found no tender, research, analytics or document-generation task (only packs support/sre/eval). Not an exhaustive read.
- Q3: Do bid/no-bid outputs belong as a Decision record on the mission? (likely yes; confirm in the screen contracts)
