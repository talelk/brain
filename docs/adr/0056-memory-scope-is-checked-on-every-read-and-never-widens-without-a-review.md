# 56. Memory scope is checked on every read and never widens without a review

Date: 2026-11-15
Status: Accepted (issue #135, spec #90)

Published knowledge had two readable scopes, the workspace and the whole organization; team and private
scopes threw "unsupported". They now work on the local store, and the rules that make them mean something
are these.

- **Who is in a scope.** A *private* asset belongs to its author (the producer of the write-up, ADR 0007). A
  *team* asset belongs to the mission team of the mission it came from: the mission's current owner (so an owner
  transfer moves access with it), the people who watch the mission, and the machine principals of that
  mission's sessions. Standing teams do not exist yet, so a team is keyed on a mission id; when they do, the key
  widens, the rule does not. A team scope names a mission of the same workspace.
- **A session sees its own team and nothing private.** A machine principal acts *for* the mission owner but is
  never the owner: it reads global and workspace memory and the team of its own mission, never private memory,
  and never another mission's team. The planner of a new mission, whose plan draft the whole workspace and its
  agents read, is a viewer with no team and no private scope. The same predicate (`visibleTo`) filters local rows
  and results of a remote memory port, so a replaceable adapter cannot widen what Brain would not.
- **Every read filters.** Memory search, the Knowledge page list, counts, planner hits, the broker behind
  `knowledge.search`, and reuse. Reuse only ever indexes workspace-wide knowledge and re-checks scope on each read,
  so narrowing after indexing takes effect at once.
- **Scope never widens without a review.** The person approving a write-up chooses its scope (default: the
  workspace); a private asset needs no second person because nobody else can read it. Widening a published
  asset takes two people's acts: the author *asks* (`knowledge.scope.request`, changing nothing anyone reads
  and showing the asset to reviewers for that one purpose) and a person with the review scope *decides*
  (`knowledge.scope.set`) for exactly that scope. The author decides their own request only when no other
  reviewer exists, and the asset is then marked self-reviewed (ADR 0007). Narrowing is immediate. Republishing
  an existing source at another scope (`memory.publish`) is refused: publication never moves what exists.
  Both commands are human-only; sessions are refused them.
- **Publication targets are checked.** A private target names the publisher, so nobody plants memory in
  someone else's view; a team target names a mission of the source workspace; for a knowledge asset the scope
  must be the one its own record gives.

Rejected: letting a reviewer widen without the author's request (a reviewer could not see a private asset to
review it, so a request is also what makes it reviewable); letting sessions read the owner's private memory
because they act for the owner (it would put one person's private notes into a team's context); a visibility
column derived from the workspace alone (it cannot say whose or which team's).
