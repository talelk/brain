# web.fetch failures and tool availability (track AA, 2026-11-11)

Dated 2026-11-11, `talelk/brain` after `499ada3`. Evidence read on the live Governor (read only): `tool_calls`, `attempt_events`, the content store.

## Finding
- Live registry showed web.fetch 66 calls / 50 failed and documents.read 21 / 21 failed. Outbound access from the runner works: 16 web.fetch calls to en.wikipedia.org succeeded, including pages that failed on other tries.
- web.fetch failures, by recorded error: 33 "tool input too large" (every large Wikipedia article: the runner handed the whole fetched HTML, up to 1 MiB, to the pinned script on stdin, which `executeToolPayload` caps at 64 KiB); 17 refusals for hosts not on the allowlist (www.notion.com, www.atlassian.com, example.com) because the model did not know the list.
- documents.read: the workspace has no documents, so every call (the model guessed ids) failed.

## Fixes
- Broker reduces HTML to main text under 48 KiB before the script runs (`readableBody` in `apps/runner/src/tools/brokers.ts`). Runner restart needed, no restage.
- The Governor derives tool availability from the workspace (`modules/resources/availability.ts`): documents.read needs a readable document (or a shortened `artifact:` reference in the pack), csv.query needs a verified CSV artifact. Unavailable tools are named in the context pack ("Not available for this task, do not call"), dropped from the engine's tool list by the runner (`contextPack.unavailableTools`), and shown in Library > Tools as "Not available: no documents yet". Available ones list real ids and titles; web.fetch lists its allowed hosts.
- Registry: calls read as a failure rate with the last error in words (`tool_calls.failure_message`, DEFAULT NULL); the tool script evidence row now opens (`tool-script:<id>` resolves to the active release's pinned script bytes).
- Not done: runs that serve no work item get no pack, so their tool list is not filtered.
