# Load and capacity

Measured 2026-11-13 on a 14-core laptop (Node 24), in-process Governor core, loopback HTTP excluded. The machine was shared with other work, so treat the numbers as ceilings of noise, not tuning targets.

| Benchmark | Result |
|---|---|
| `pnpm bench` (starter org; 100 queries, 50 commands) | query p50 0.35 ms, p95 0.74 ms; command p50 5.7 ms, p95 9.5 ms; 277 MB |
| `pnpm bench:steady:quick` (25 workspaces, 50 runners, 100k jobs, 1000 pending approvals; 20 operations a second, bursts of 50; 3 x 60 s) | medians: query p95 52 ms, command p95 49 ms, 24 ops/s, 563 MB, no errors. The first trial is the cold one (query p95 about 180 ms) |

Over their budgets in two runs: **event-loop delay p99 about 165 ms** (budget 50) and the **10x-history list p95 181 to 573 ms** (budget 150). The 10x case looks like a scan (backlog row 96). The full gate protocol (3 x 10 minutes) was not run.

**Regression threshold.** `pnpm bench` now exits non-zero when query p95 passes 50 ms, command p95 passes 100 ms or memory passes 1 GB; the steady benchmark keeps its own budgets and exit code. Run `pnpm bench` before a release (`verify:release` does).

**Decision: keep SQLite, with the replica (ADR 0027), until the benchmark says otherwise.** The Phase 4 target is about 50 missions a week for three teams, which is far below one operation a second against a store that sustains 24 a second with command p95 under 50 ms. One writer, WAL, and a second-host copy cover it. Revisit when the steady benchmark's 1x medians pass their budgets, when sustained load approaches 20 operations a second in production metrics (`brain_queue_depth`, attempt duration), or when snapshots take long enough that replica lag stays degraded.

**Capacity.** Concurrent work is the slots of the online runners (Health, `runners`); a second runner host adds its slots (docs/howto/replica-and-second-runner.md). Queue depth and the age of the oldest queued job are in `/metrics`, with an alert at 30 minutes.
