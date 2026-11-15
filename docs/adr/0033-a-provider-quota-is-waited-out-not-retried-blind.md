# 33. A provider's quota or rate limit is waited out, not retried blind

Status: accepted, 2026-11-15. Amends ADR 0022 (failure classes).

A model provider that answers 429 or "quota exceeded" was reported as "model endpoint" (the person was told to check the model address), classified as a model slip or no class, and retried at once on the same route, so each retry spent a turn against a closed door.

## Decision
1. Failure classes gain `quota`, with one remedy `wait-for-quota`. The Governor decides it from the failure detail (a 429 or quota or rate-limit words), after the spend cap and before everything else: a refused model call says nothing about tools or checks.
2. The engine adapter says it first: the failure detail leads with `quota or rate limit`, then `(retry after Ns)` when the provider named a wait, then the vendor's own message. The lead survives the 500-character cut and is what the person reads (run page code `quota`, task card, next action).
3. The wait is the provider's retry-after, kept between 5 seconds and 15 minutes; 60 seconds when it named none. It spends no attempt. After 5 waits in a row the failure counts and the task parks at the mission's threshold like any failure.
4. Pi reports a Retry-After header only as the error "Server requested Ns retry delay", so the adapter sets the vendor's provider retry delay limit to 1 ms to turn the header into text, and cancels the vendor session's own in-place retries of a quota failure. A delay named only in the body is read from its words; a failure naming none gets the vendor's one quick retry.

## Consequences
- A quota is no longer shown as an unreachable model, and no longer burns turns in place.
- The Governor's wait is per task; it does not choose another route. Failing over to another model route when one account runs dry is ticket #126, which builds on this class.
- Only engines that report an error event (Pi, Claude) lead with the cause; ACP and OpenCode failures reach the Governor as their own text and are classified only if that text names a quota.
