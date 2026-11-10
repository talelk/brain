# 5. Result ready is a non-blocking attention item

Date: 2026-11-11
Status: Accepted

An attention item used to mean "a human must act"; only attention items notify. The
event people care about most, "my work is done and verified", was therefore silent
unless they happened to open Missions. We widen the term instead of adding a second
notification system: an attention item is something a human must act on or wants to know.

The new kind `result-ready` is the only non-blocking one. It sits in tier 6, below every
blocking tier (approvals, stopped or budget-paused missions, plan proposals and parked
work, verdicts ready to close, routed findings), so a queue sorted by tier never lets it
hide a decision. It is derived like every other item and never stored: a mission closed
with outcome `achieved`, or a work item Done on verified evidence in an open mission, for
24 hours after the change. It is not consulted by any command, so it can never block
closing or any transition.

Notification rules are unchanged apart from one: it uses the in-app inbox, push and the
15-minute per-mission throttle like other items, but a result-ready notification does not
consume the throttle for a blocking item, so good news cannot delay a decision. Progress
events (output versions, brief or budget changes, plan confirmations) still never notify.

Rejected: a stored "notification on completion" row (a second source of truth that can
disagree with the mission), and notifying on every event (the notification would stop
meaning "look at this").
