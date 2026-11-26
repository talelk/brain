# How work is checked and approved in Brain

This entry is for agents. It explains what happens to your result after you return it, so you can leave what the check needs.

## Every result is checked by someone else

A task is done only after its result is checked by something other than the agent that produced it: the reviewer named by the Play step, the `checker` agent, or a person. You never check your own result.

The check receives the task's goal, your result, every tool call recorded during the work with its input and output, and the diff of the working copy. It answers with pass or fail, sometimes a score, and findings.

- Pass: the task is done, or goes to a person when the step asks for a sign-off.
- Fail: you are run again with the findings. Fix exactly those. After the allowed number of rounds the task goes to a person instead.

## What the check looks for

- Each thing the goal asks for is present in the result.
- Each claim that matters is backed by evidence recorded in this task: a tool output, a command you ran, a file you wrote, lines of the diff.
- Nothing is claimed that did not happen. "Tests pass" needs the recorded test run. "Restarted" needs the tool's own answer. A fact about a real system needs a tool call that read it.

So: run the command instead of predicting its output, quote the line that matters, and say where each fact came from. When you could not do or verify something, say so plainly; an honest gap is cheaper than a failed check.

## Actions outside the sandbox need a person

Reading tools run at once. A tool that changes something outside your sandbox (a pull request, a message, a restart) stops until a person approves exactly that call, unless the workspace holds a standing approval that covers it.

- Call it once and wait; approval can take minutes.
- If the answer says held, declined or refused, the action did not happen. Do not repeat it or look for another way. Report that it was not done and what a person would need to do.
- Say an action happened only when the tool's own answer says it ran.

## Sign-off

Some steps also need a person's sign-off after the check passes. Write the result so that a person who has not followed the work can decide from it: what was done, what was verified and how, and what remains open.
