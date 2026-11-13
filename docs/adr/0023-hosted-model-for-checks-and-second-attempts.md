# 23. A hosted model may check results and take second attempts, per workspace

Status: accepted, 2026-11-13.

Today every role (planning, work, checking) uses one self-hosted model server reached over the network (`BRAIN_LOCAL_MODEL_URL`, no key). The independent check is independent in process and trust domain but not in judgement: the checker shares the worker's blind spots. A second, different model lifts the quality of both checks and retries.

## Decision
1. **A workspace can switch on a hosted model for two roles only:** the evaluator and the second attempt of a failed task. Planning and first attempts stay on the self-hosted model.
2. **The switch is per workspace and off by default.** Sensitive workspaces stay fully self-hosted.
3. **What leaves the instance is limited to** the task, its result and its evidence. No workspace documents are sent beyond what the task read, and credentials never are.
4. **The choice of model and vendor is the owner's**, set in Administration, not in a release.

## Why
A second opinion from a different model is the cheapest real independence gain. Per-workspace control keeps the data decision with the owner of the data.

## Limits (be honest)
- Redaction of host output is pattern based (ADR 0021). A workspace that reads production hosts, such as `sre-demos`, should not be the first to switch this on; start with a workspace of documents.
- The hosted model is a second dependency: when it is down, checks and second attempts wait, and Health must say so.
- Cost appears for the first time on workspaces that use it; the spend cap and per-task budget must cover it before it is enabled.
