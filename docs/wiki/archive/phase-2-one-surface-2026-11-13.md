# Phase 2, one simple surface: what was built and what is left (2026-11-13)

Decisions and design: ADR 0024. Verification: `pnpm build`, `pnpm test:browser`, `pnpm verify:fast`, `pnpm test:integration`.

## Built
- One live store (`apps/web/src/data/live.ts`) fed by `GET /v1/events?live=1&wake=1&after=head`; every `refreshMs` and `setInterval` outside the store is gone (guard: `tests/domain/live-store.test.ts`). One Refresh and one freshness label in the header; shared attention and missions reads.
- Four places (Today, Missions, Library, Administration) from `ui-screen-contracts.json`; Today's Working-now strip; Missions Running filter; `/` always opens Today (`LiveStatus.defaultRoute` removed).
- Message catalogue en/fr/ar (`apps/web/src/i18n`, `scripts/i18n-add.py`), language menu, Arabic right to left from the document direction, `tests/domain/i18n-catalog.test.ts`, `tests/browser/i18n.spec.ts`.
- `DecisionCard` for plan proposals, approvals, stopped tasks, unknown outcomes, budget pauses and verdicts; Decide and Retry only.
- Outputs: the answer to the goal first, attempts folded under Attempts, true totals and cursor paging (`artifacts.list`: `kind`, `cursor`, `limit`, `totalEstimate`, `workItemId`), files named after tasks.
- Library: "What Brain has learned" with where it was learned; `helpedCount` and `expiresAt` render when the Governor reports them.
- First run: plain names on the setup checklist; `install-ready.spec` asserts empty install to first verified result in under five minutes.

## Review findings (archive/review-plan-live-outputs-2026-11-12.md), status
Fixed: 6, 14, 43 (counts and CTA agree: one store; a stopped task offers Decide), 59 (one Refresh), 7, 27 (server names the producing task), 10, 11, 13 (blocked task link), 17, 18, 20 (Live opens on Nothing is running with the latest outcome), 24 (View logs once; Attach says what it does; Running now; Stop already asks for a reason), 28, 31, 37, 42, 51 (intended: an auto-start mission closes when every task has an independent verified verdict; the guide now says so), 53, 57, 29 is praise.
Not fixed here: 30 (raw nginx 502: server configuration, backlog row 73), 38 (launcher, model endpoint and disk in Health: phase 0).
