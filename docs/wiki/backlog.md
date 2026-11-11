# Backlog: open items only (lean on purpose)

Dated 2026-11-11, at `talelk/brain@e38aa19`. The full history of every track, report and finding is in [archive/backlog-2026-11-11.md](archive/backlog-2026-11-11.md) (excluded from the agent context budget: read it only when you need the history). Keep THIS file short: when an item is done, delete the row here and note it in the archive/history pages, never the other way round.

## In progress
- Track M (UI editor), rows 47-50 done locally (not deployed): auto-published self-reviewed write-ups (setting `library_settings`, Approve all verified, Today line), substantive write-ups with a 200-character threshold and supersede, six starter Plays with `plays.addStarter` (live has none: restage or click "Add starter Plays"), Library tab strip, one-segment bars, 24-hour times. Still open from M: Health "Recent activity" plain sentences (`payload.message` of `tool.read.refused`); Setup stepper third circle shows "3" not a tick; row 53. Deploy note: schema adds two DEFAULT columns on `knowledge_assets` and the table `library_settings`; the first sweep rebuilds and publishes the 19 thin unreviewed write-ups (Withdraw undoes one).

## Open
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator proves criteria were answered, not that answers are correct; real-model quality 10/12 pass in `scripts/qualification/task-quality.mjs` | measure/improve; consider a model-judged independent check |
| 26 | #77 meter: interactive runs outside missions are not in the usage ledger | |
| 27 | Sidebar highlights Live on /runners; Passkeys paragraph jargon | UI |
| 32 | "Reading N sources" doing-now sentence missing on session rail / Plan rows | needs transcript |
| 33 | `first-launch` and a few integration tests still time out under heavy machine load | pass alone; E2 timing factor helps |
| 35 | Trust read lacks per-criterion evidence link and mission-level aggregate | |
| 36 | Budget-pause and routed attention items open their page instead of acting inline | |
| 38 | Run all new specs at 390-dark / 768 / RTL (only 1440-light, 390-dark, 768-light fully covered) | QA |
| 40 | Share page is text only (no Markdown rendering/branding) | |
| 53 | UI for track K: send `sourceMissionId` from `RepeatSheet`; link schedule history `dispatchRef` starting `mission-` to the mission page; mission Outputs tab shows recorded named outputs under "Documents with versions" next to Result cards: hide or merge | UI |
| 54 | Notification-throttle behaviour across restart and share-token expiry races not examined (K item 7); a read job interrupted 5 times keeps its reservation until a person resolves it (by design) | adversarial tests |
| 55 | Saved documents are searchable but not queued for Review; result-ready announcement not extended to the inbox | I3 leftover |

## Found live 2026-11-11 ~09:15 (track K deployed, `bd16582`)
- Token meter is empty: `mission_spend` has 59 rows, all with 0 input/output tokens, `estimated=0`; closed mission shows "No usage recorded yet". Agents emit usage; it does not reach the ledger. Track N is tracing it (Pi engine -> attempt usage -> settlement) and will add estimated counts when an endpoint reports none.
- Tool refusals on live (Health "tool read refused") confirmed as `documents.read` calls with an unknown document id / missing context reference (model guessing ids), not a broker bug; K's fix makes refusals explain themselves.
- Repo token budget check tripped (141k/140k): history moved to `docs/wiki/archive/` (excluded from the budget); keep this file lean.

## Not yet walked live (blocked on deploy of K and M)
Share links, Challenge this result, Repeat this (now creates real missions), Context received tab, Tools registry, Quality page, Usage meter in depth.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; new columns on existing tables need DEFAULT; deploy through scripts/deploy-demo.sh then scripts/stage-demo-release.sh when `examples/v1` changed.
