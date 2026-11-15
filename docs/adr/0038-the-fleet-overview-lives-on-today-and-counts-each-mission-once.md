# 38. The fleet overview lives on Today and counts each mission once

Date: 2026-11-15
Status: Accepted (spec #90, stories 43 and 44)

Every member needs the state of everything at a glance, but runner internals are for administrators, and a page of its own would be a fifth place (ADR 0029).

**Decision.** The fleet overview is a section of Today, read through the one live store. One query, `fleet.overview` (`workspace:read`), computes it at the Governor, so counts are exact past the list clamps and testable at the query seam. Each open mission is counted once, in the first condition that holds: needs attention (a blocking attention item names it, including an approval its proposing attempt raised), working (an unsettled attempt of it), else waiting. The three always add up to the open missions; an approval of a standalone run belongs to no mission and is counted apart. Active team members are those serving a task through a starting, running or waiting session. Runner capacity is a sum over enabled, recently heard runners and is organization-wide; the runner list (id, group, status, slots) is added to the answer only for a holder of `runner:admin`. Spend today is the daily cap's own figure: settled cost over the trailing 24 hours plus open reservations.

Rejected: composing the overview in the browser from `missions.list` and `runners.list` (clamped lists, and `runners.list` carries engines and capabilities); a separate Fleet screen.

Known gap, left alone here: `runners.list`, `runner.get` and `job.explain` are readable by any workspace member through the API, so "runner internals stay admin-only" holds for the overview and the navigation, not yet for those queries.
