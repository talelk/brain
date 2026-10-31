# Run your first task

Open the address printed by `rtk pnpm brain start`. On a fresh installation, sign in
as `admin@brain.local` with password `admin-password`. No password change is required. Brain
selects **My workspace**. Set `BRAIN_ADMIN_PASSWORD` before initialization when using
a different credential or exposing Governor beyond the local host.

From Today, select **Start a task**. Two tasks are included:

| Task | What to provide | What you receive |
|---|---|---|
| Investigate an operational issue | Describe the situation and known facts | An analysis, blockers and proposed next steps |
| Draft a support response | A ticket title and description | A response draft for review |

Choose a task, enter its inputs, select **Review task**, then explicitly select **Start task**. Brain opens the run
page. If validation fails, correct the indicated fields; the form keeps your input.
If acceptance cannot be confirmed, select **Start task** again on the same review to recover the existing run. Do not prepare a different task merely to retry a lost response.

On the run page, Summary contains the structured result. Evidence shows the independent
validation result. A model response alone does not mean the task passed validation.
These checks establish output structure and allowed fields, not the accuracy of advice.
The starter tasks do not send messages or execute remediation. The context tool uses
local demonstration information, not a connected production system.

If a task waits for a model connection, an administrator can open **Administration → Setup**,
enter the self-hosted model API URL and model ID, and select **Test connection and start
runners**. The task runner and validator pair automatically. The installation-test action
in the setup checklist verifies execution; finding a model alone does not prove a task
will succeed. Other engine and deployment configurations are described in
[Run the local stack](run-local-stack.md).

For workflows that propose real external actions, use [Runs and approvals](operate-runs-and-approvals.md).
An approval is distinct from execution. If an effect's outcome is unknown, reconcile it
before retrying.

## Conversation and work items

**Ask Brain** can ask for missing inputs and propose an existing task. Its model work is
independently checked. Select **Review proposed task**, edit inputs if needed and then
select **Start task**. The proposal stays inert until that confirmation. Recent
conversations are available in the same workspace; other users cannot read your thread.
If the conversational model is unavailable, choose a task directly.

For a card, ticket or incident, open its details and select **Start a task for this item**.
Review the prefilled information before starting. The item lists related runs and their
current state, and each run links back to its originating item. Completing a task does
not automatically mark a card Done or approve an external action.
