# 77. Signed webhooks record subjects and never decide

Status: accepted, 2026-11-16.

External coding tools, CI and ticket systems report into Brain as subjects (ADR 0075). Until now a subject arrived only by polling (the GitLab connector) and incidents had no producer. A webhook is an unauthenticated network request that a person on the other side of the internet can replay, so what it may do has to be narrow and what it proves has to be checked before it is read.

## Decision
1. **One signed address per source and workspace.** `/hooks/github/{id}`, `/hooks/gitlab/{id}` and `/hooks/ticket/{id}`. The id names the endpoint, which belongs to one workspace of one organization and holds its own secret (encrypted at rest under its own key label, replaced only by rotation, never read back, never in an event, a log or a stored command request). GitHub is checked as HMAC-SHA256 of the raw bytes (`X-Hub-Signature-256`), GitLab as `X-Gitlab-Token`, and the generic ticket webhook with Brain's own HMAC of `<timestamp>.<body>` inside a 5 minute window.
2. **Order of work.** Size bound (1 MB), then endpoint lookup and the provider's signature over the raw bytes, then parsing. An unknown endpoint, an endpoint of another kind and a wrong signature are one answer after the same work; the reason is never said.
3. **Replay.** A delivery id is handled once per endpoint, and so are the same bytes under a fresh delivery id (GitHub signs no timestamp, and its delivery id is outside the signed bytes). The delivery record is written in the workspace database in the same transaction as its effect, so a crash cannot lose an event, and a replay of a delivery that asked the triggers about a new subject asks them again (they are idempotent per automation and subject). Domain keys are the second guard: a ticket or incident is keyed by its remote id.
4. **What a delivery can do.** Create or update a ticket or incident subject (opened, closed, reopened, labeled), add a state observation or a check result to the pull request record (#121) whose address matches, and ask the subject triggers (#122) about a subject that is new and open. It has no path to confirming a plan, approving an effect, recording a verdict or any command: the receiver holds no actor.
5. **A request or check with no record becomes a subject that never starts work.** A pull or merge request, or a finished check, whose address matches no recorded pull request is kept on a ticket subject keyed by repository and number, so its state is visible. Only an issue or an incident that opens (GitHub, GitLab, or the generic webhook) asks the triggers; an unknown author's pull request cannot start a mission by opening one.
6. **Unhandled events are acknowledged.** `ping` and events Brain does not use return 2xx and are listed as ignored, so a provider does not mark the hook failed. The administration screen shows the last deliveries as status only: event name, recorded or ignored, a short reason, and when.

## Consequences
- Incident subjects now have a producer; the generic webhook is how an incident system opens one.
- A captured GitHub body replayed after the 30 days deliveries are kept would be accepted once more: states are idempotent, but an old state could be written over a newer one. Providers sign no timestamp, so this is accepted.
