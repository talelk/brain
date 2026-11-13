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
