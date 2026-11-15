# 52. A subtask is a work item the plan names, and its parent waits for it

Status: accepted, 2026-11-15.

Work items had no hierarchy. A person or coordinator wanted to break one task into parts and see them roll up, without a second kind of card (ADR 0001) and without the parent claiming Done on its own.

## Decision
1. A subtask is an ordinary work item. It is created only through a plan version: a plan task may carry `parentId` naming another task of the same plan. There is no command that adds a child outside a plan, so people (the plan editor) and coordinators propose subtasks the same way and the same autonomy policy applies.
2. One level: a parent is never itself a subtask. A subtask and its parent may not depend on each other, and the parent counts as waiting for its subtasks when a plan is checked for cycles, so a loop through a parent is refused as a deadlock.
3. `parent_id` points at the parent's live work item. A confirmed plan re-points every subtask to the item it selected for the parent, so a replaced parent keeps its subtasks. Changing a task's parent counts as changing the task: started work cannot be re-parented.
4. A parent is Done only when every live (not abandoned) subtask is Done. Its own evidence is still required (ADR 0022); subtasks done does not make the parent done. A task already Done takes no new subtask.
5. Abandoning a parent with open subtasks is refused. A person may abandon it with `cascade` and a reason; each open subtask is abandoned showing "Parent abandoned: <reason>". Subtasks already Done stay Done. An agent cannot cascade.
6. The parent reads a roll-up (done count, tokens and cost of itself and its live subtasks, from the usage ledger by work item). The mission total is unchanged and counts each attempt once. Priority, tags and due date are per item.
7. A delegated child session (#110) is a run of the mission, not a subtask.
