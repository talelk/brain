# 30. An attempt is judged while it runs, and a finished answer is kept

Status: accepted, 2026-11-13.

Live, a synthesis task used 277k tokens in one attempt (allowance 100k), and its complete report was dropped as `agent ended with error`: Pi measured the attempt only after the model finished, and every turn re-sends the whole conversation.

## Decision
1. At each tool call the engine reads the attempt's use. At 80% of the tokens (or when the next turn would not fit) the call is refused and the model told to write its answer; past the allowance and still calling tools, the session stops.
2. A written final answer is kept whatever it cost; the tokens are charged, so the task cap still bounds the task.
3. A model sees at most 16,000 characters of a tool answer (the artifact keeps all). A repeated read-only call is told it was answered; a failed call may be retried; a change tool is never answered from memory (ADR 0028).
4. A failure reads `agent ended with <reason>: <cause>` (budget, context overflow, schema mismatch, tool error, aborted, model endpoint), at most 500 characters, redacted by the Governor.

The 200,000 task cap and the agent's `maxTokens` are unchanged; the Claude engine keeps its fail-closed money cap (ADR 0006).
