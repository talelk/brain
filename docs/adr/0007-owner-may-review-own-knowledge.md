# 7. A single owner may review their own knowledge, with a visible mark

Date: 2026-11-11
Status: Accepted (issue #72)

The glossary required a memory publication reviewer who is not the publisher. A
one-person install cannot satisfy that, so the capitalization loop (a finished mission
proposes a readable knowledge asset, a person approves it, search and agents reuse it)
would stall at "extracted" forever. The Library review inbox also approves and publishes
in one action, so "reviewer is not the publisher" can no longer be the thing we check.

We check **producer is not approver** instead, and allow an explicit exception for
knowledge:

- The producer of a mission knowledge asset is the mission owner; of a saved document, the
  person who uploaded it. Brain itself (the capitalization run) never counts as a person.
- A different person with the review scope (`memory:publish` in the workspace) can always
  approve.
- The producer may approve their own asset only when no other active human in the
  workspace holds the review scope. The asset is then stamped `self-reviewed`: the mark is
  stored, shown on the review card, on memory search hits and on the "Reused" line of any
  result that used it, and the audit event records it. As soon as a second reviewer joins,
  the exception stops applying to new proposals; existing marks stay.
- It applies to knowledge assets and (when decided) proposed Plays only. It never applies
  to approvals, external effects, capability candidates or tool publication, which keep
  their own separation of duties.
- Revoking removes the asset from search and reuse at once.
- **Automatic publication (backlog 47).** While the exception applies and the workspace setting "Publish verified write-ups automatically" is on (default), a verified mission's write-up publishes itself as self-reviewed and auto-published; Withdraw undoes it. It stops when another reviewer exists or the write-up appears to hold a secret. With the setting off, "Approve all verified" approves every waiting write-up.

Why this is safe: knowledge is advisory. A reused item enters planning and sessions as a
claim with provenance, never as evidence for a criterion, so approving bad knowledge cannot
make bad work pass verification. Publication still runs the secret scan and stores the
content as a digest-pinned artifact, and revocation is one action.

Rejected: (a) always require a second principal (stalls every single-owner install, which
is the default shape); (c) delay-and-reconfirm (adds waiting without adding a second
opinion); step-up authentication (the step-up challenge is bound to an approval record and
a subject digest of an effect; reusing it for advisory knowledge would add machinery to
guard a non-authoritative act). If knowledge ever gains authority over execution, revisit
this and require step-up.

## Amendment 2026-11-11 (track AB): hands-off missions publish too

Automatic publication does not depend on who closed the mission. A mission the Governor itself closed as achieved (hands-off:
every task Done on independent verified evidence, then the Governor's mission verdict) publishes its write-up as self-reviewed and
auto-published on exactly the conditions above: no other active human holds `memory:publish`, the workspace setting is on, the
write-up has substance, is not a sample or test mission and holds no secret. A write-up whose producer is no longer an active
reviewer (a departed mission owner) is published under the workspace's sole reviewer; a saved document from Brain or an agent still
waits for a person. With two or more reviewers, or none, everything stays in the inbox. The sweep re-evaluates every waiting write-up
on each capitalization pass, so write-ups that were waiting before this change publish on the first pass after deploy (no
migration). Effects, approvals, capability candidates and tool publication are untouched.

The Library overview now counts only what needs a person as "Awaiting your review" (write-ups needing a second reviewer or set
aside for a secret, tool candidates, Play proposals) and counts what Brain published itself apart as "Published automatically".
