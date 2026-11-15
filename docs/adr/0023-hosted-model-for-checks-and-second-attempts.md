# 23. A hosted model may check results and take second attempts, per workspace

Status: accepted, 2026-11-13.

Today every role (planning, work, checking) uses one self-hosted model server reached over the network (`BRAIN_LOCAL_MODEL_URL`, no key). The independent check is independent in process and trust domain but not in judgement: the checker shares the worker's blind spots. A second, different model lifts the quality of both checks and retries.

## Decision
1. A workspace can switch on a hosted model for the evaluator and for the second attempt of a failed task only. Planning and first attempts stay self-hosted.
2. The switch is per workspace and off by default.
3. Only the task, its result and its evidence leave the instance; never credentials.
4. The model and vendor are the owner's choice in Administration, not a release setting.

## Limits
- Host output redaction is pattern based (ADR 0021): a workspace that reads production hosts, such as `sre-demos`, stays self-hosted. The first workspace to enable it is the demo workspace, which holds only documents and sample files.
- When the hosted model is down, checks and second attempts wait, and Health must say so. Spend caps must cover its cost first.
- Built as: the route names a place, never a key (`BRAIN_MODEL_KEY_<REF>` on the runner, named by the route's key reference; routes are ordered and fail over per ADR 0055); a workspace with host tools cannot switch it on. The Claude engine takes the route per attempt through a private environment, never process.env.
- Priced: a hosted model is saved only with both token prices (micro-USD per million tokens). The route carries them and the runner reports spend as tokens x price (rounded up; cached input at the input price), so hosted spend settles as dollars and mission and workspace caps stop further attempts. Without both prices a model cannot be saved or switched on, and a route without them is not accepted by the runner.
- The advisory judge (#95) is a third use: when a mission evidence bundle is submitted, the Governor itself asks the hosted model (OpenAI-compatible chat, with `BRAIN_MODEL_KEY_<REF>` from its own environment, the key of the first enabled route it already reads for the health probe) for one opinion per success criterion, written as an advisory check with its transcript as evidence. This is the one call that does not go through a runner. It never records a verdict, changes a bundle or links a criterion; without a usable hosted model it records nothing and the sign-off view says no judge ran; an outage writes nothing, never blocks sign-off, and is retried (three tries, five minutes apart) or waits while Health says the model is down. Each call is priced from the route and settled as mission spend, and the mission's dollar budget and the workspace caps refuse the next call first. One request row per bundle makes it resumable after a restart.
