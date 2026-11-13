# 31. An attempt spends turns, so its tool calls are bounded by its task

Status: accepted, 2026-11-13.

Live, "Run docker.ps to enumerate running containers" used about 110k tokens per attempt (allowance 100k) although its tool answers were 2 KB. Reproduced with the real Pi engine and model (`scripts/probe-sre-attempt.ts`): the cost is turns. Each turn re-sends about 6k tokens before any work (system prompt, tool definitions, context pack, task) plus the conversation, and the model kept looking for something the tool does not print (an image name `docker ps` was not asked to show) until it had made 7 to 8 calls. The 80% steer did not help: a refused call still costs a whole turn.

## Decision
1. The instructions are the session's system prompt and are sent once; the first message is the task (they were sent twice, about 2k tokens per turn).
2. An attempt may make at most one tool call per acceptance criterion (2 to 12; 8 when the task lists none), never more than the agent's turn limit. Refused and repeated calls count: they cost a turn.
3. The model is told its limits up front, and each tool answer ends with the calls and tokens used.
4. A repeated read is told firmly that it already has the answer; the second repeat ends tool use.
5. At the last call, at the repeat budget or at 80% of the allowance, the engine removes the tools and steers once with the exact tokens left, so the next turn can only be the answer; anything not shown by a tool is answered `met: false`.
6. The answer is the model's last message. What it says while calling tools is on the diagnostic channel and never part of the deliverable.
7. A tool-using agent's context pack is at most 4,000 tokens; what is cut is one read away by reference.

The 200,000 task cap and the agent's `maxTokens` are unchanged (ADR 0030).
