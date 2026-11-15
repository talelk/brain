# 71. A risk tier asks more of an approval, and never skips one

Status: accepted, 2026-11-15. Extends ADR 0024 (every effect carries its own approval and permit), ADR 0049 (approval origin and context) and ADR 0067 (policy enforced while work runs). Weakens nothing in them.

An effect's risk was only the fixed class read, write or privileged. A restart of a production container with no rollback and a ticket in a scratch environment asked the same thing of the approver: one person and a step-up that was only a TOTP code when the server required two-factor everywhere.

## Decision
1. **A risk tier is computed by code, per request.** `assessRisk` scores facts the Governor already holds: effect class (write 1, privileged 3), a production environment by the ADR 0067 rule (+2), the kind of system (repository, ticket system, host, external tool, +1), files outside the declared target (absolute, `..`, CI or credential paths, +2), no declared rollback on a changing effect (+1, ADR 0049) and an autonomous mission (+1). The score maps to low (0-3), elevated (4-5), high (6) and critical (7 and above). Each fact that counted is a reason with a code and a plain sentence; no model is involved, so the same facts give the same tier and reasons.
2. **The release policy may only raise it.** A production change under `productionHumanApproval` is at least high, whatever its score, and says so as a `policy-floor` reason. No policy value lowers a tier.
3. **The tier is bound at request time.** The Governor stamps `risk` (tier, reasons, requirements) on the approval's subject at all three places an approval is created (an agent's effect request, a workflow gate, the `approval.request` command), overwriting whatever the proposal said. The subject digest covers it, so a tier cannot be edited afterwards: a decision on a subject that no longer matches its digest is refused. A decision also recomputes the tier; if it has risen since the request the decision is refused and a new approval under the new tier is needed. The requirements bound at request time hold even if the facts later fall, so an approval is never decided under a lower tier than it was requested with.
4. **Elevated and above need a TOTP step-up.** The challenge's method is `totp` whatever the server's own two-factor setting, a person without an enrolled authenticator cannot start one, and the decision refuses non-TOTP evidence. Below elevated the ordinary step-up applies as before.
5. **Critical needs a second, different person.** The first approval is recorded (with its own step-up evidence) and the request stays pending with its version moved on; it wakes nothing and issues no permit. The second approver must be another person than the first, the requester and the owner of the mission it serves. `approvalCurrentlyUsable` re-reads that another enabled human with the approver scope holds a TOTP approval before the permit is taken. A rejection by anyone ends the request.
6. **Nothing is skipped or shared.** Each effect keeps its own approval and its own single permit (ADR 0024). A tier only adds requirements to that approval; approving one effect approves no other, whatever its tier.
7. **The approval shows it.** Inbox, detail, the phone card and the Needs-you dialog show the tier beside the context, with its reasons, what it asks of the decider and who has approved so far. No new command or route is added: decisions use `approval.decision`.

## Limits
- The scale and weights are fixed in code, not configurable per organization.
- "Files outside the declared target" is judged on the file paths of a change (the pull request tool); a Tool document has no declared path scope to compare against.
- A stale approval whose tier rose is refused, not replaced; it expires and the request is made again.
