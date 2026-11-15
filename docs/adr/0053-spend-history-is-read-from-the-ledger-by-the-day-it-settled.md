# 53. Spend history is read from the ledger by the day it settled

Status: accepted, 2026-11-15.

Spec #90 (stories 49, 50) asks for spend over time and for cost per verified task by agent and Play. Extends ADR 0009 and ADR 0051; no new store.

## Decision
1. `usage.series` (`resourceId` `workspace`, `mission:<id>` or `agent:<id>`; `limit` = days, at most 90) returns one row per UTC day ending today, from the same ledger rows as every total. A row counts on the UTC day its attempt settled (`settled_at_ms`), so the days of a window reaching back to the first settlement sum to the scope's settled total (ADR 0009 settles an attempt when its runner releases capacity). Reserved spend is not in the series. Days without spend are present as zero. Member scope is not offered: member ids are a plan's own labels.
2. `usage.verifiedCost` reuses the Quality summary's arithmetic over the trailing 30 days (settled spend in the window divided by tasks that reached Done in it), split two ways. Per agent: the agent's settled spend over tasks it had an attempt on; a task several agents worked on counts for each, so agent counts overlap and are not summed. Per Play: spend of missions started from the Play over those missions' Done tasks; missions without a Play form one group; runs outside missions and the advisory judge's calls belong to neither split. A row with no verified task has no per-task figure.
3. Every figure ships its definition in the payload; the browser only formats. Days are UTC, labelled so.

## Consequences
A day's bar moves only when an attempt settles, never when a later reassignment happens (ADR 0051 stamps agent at claim). The chart is an owner read at `workspace:read`, like the other usage queries.
