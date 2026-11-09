# 4. A mission advances on events and is never a run

Date: 2026-11-07
Status: Accepted

A mission may last weeks, but no run, session or model is kept alive for it. The
Governor advances a mission by reacting to events: a run finished, a dependency was
satisfied, an approval or a human message arrived. For each ready work item it
dispatches a fresh, bounded run. While a mission waits, nothing holds a runner slot
or a model session. The coordinator also runs as bounded sessions that these events
wake.

The obvious alternative was one long-lived workflow run per mission. It was rejected
because the workflow runtime (Mastra, `@mastra/core` 1.79.0) executes one fixed
graph per run. It cannot take on a new plan version, and since v1 it has no durable
event or timer wait: `suspend()` survives restarts but needs an outside `resume()`,
and `sleep` does not survive a restart. Each run therefore executes exactly one
digest-pinned plan version. A changed plan starts new runs, and the Governor owns
event matching, timers and plan versions.

Decided in [Missions advance on events and are never a run](https://github.com/talelk/brain/issues/11);
runtime facts from [Mastra durable suspend/resume and plan changes mid-workflow](https://github.com/talelk/brain/issues/20).

## Starting ready work

A mission has an `autoStart` switch (default on; "ask me before each task" is off).
With it on, the Governor starts every ready work item after the events that can
make one ready (plan confirmed, a dependency verified Done, a budget raised, a
mission resumed, the switch turned on) and on the maintenance pass, through the
same `workflow.dispatch` with the work item that a person's Start uses. A finished
run moves its work item to review; Done still needs a verified evidence bundle.
Inputs are never invented: the input is what the Start form pre-fills from the
card, and a task with no workflow or input its workflow rejects stays `ready` with
the next action "Needs input before it can start". The member cap bounds
in-progress work and a spent budget holds new starts; both leave a visible next
action and resolve on the next event. Missions with a play coordinator keep using
the coordinator.
