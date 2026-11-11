# 15. A Play proposal is a reviewable description that opens a draft, never a Play

Date: 2026-11-11
Status: Accepted (issue #74)

**Q1 decided: Plays stay release-defined content.** The active release holds the Plays; the Governor reads them from it. A finished mission can therefore never create a Play by itself. It can only suggest one.

**Proposal.** "Propose as Play" (`play.propose`, scope `mission:write`) is offered on a mission that is closed with outcome `achieved`, which already required a verified mission verdict. A cancelled, paused or unfinished mission is refused, and a mission can have one proposal. The proposal is built only from stored records: the mission's title, intent and success criteria, its confirmed plan version's tasks (title, criteria, dependencies, assignment, workflow, output names; inputs that point at other missions are dropped) and team, its autonomy preset, parking threshold, member cap and money ceiling. It never copies handoff notes, messages, accepted decisions, findings, documents or output content; a test plants hostile text in each and asserts none appears. The proposal is stored in the workspace (`play_proposals`) and counted in the Library's "awaiting review".

**Review.** `play.proposal.review` needs `config:activate`, because the next step is authoring configuration. Approve opens an ordinary configuration draft of kind Play (`plays/<id>.yaml`) through the existing `configDraft.create` path and links to it in the Studio. It does not validate, publish, stage or activate anything: those steps, and their gates, are unchanged, and a test asserts the release and active-configuration counts are identical after approval. Reject records the reason and opens nothing. A retried decision returns what it already did.

**Self-review.** ADR 0007's exception is applied to proposals: the person who proposed may approve their own, and the proposal is stamped `selfReviewed`. This is safe because approval grants no authority; the draft still has to pass the compile and activation steps that require `config:activate` and the release gates.

**Why not propose automatically.** Closing a mission already writes a knowledge asset. A second automatic artifact per mission would flood the inbox with one-off work; an explicit "Propose as Play" keeps the signal high and the choice with a person. The Library shows the button next to the knowledge note on an achieved mission's Outputs tab.
