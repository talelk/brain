# Run your first task

Last reviewed against commit 6fb59ae.

Open the address printed by `rtk pnpm brain start`. On a fresh installation, sign in
as `admin@brain.local` with password `admin-password`. No password change is required.
Brain selects **My workspace**. Set `BRAIN_ADMIN_PASSWORD` before initialization when
using a different credential or exposing Governor beyond the local host.

The five areas in the top navigation are **Missions**, **Live**, **Logs**, **Outputs**
and **Plays**. Knowledge is under **More**; Administration is in the account menu. See
[Screen descriptions](../screen-descriptions.md).

## 1. Connect a model (administrators, once)

If work waits for a model, open the account menu, then **Administration → Setup**.
Enter the self-hosted model API URL and model ID and select **Test connection and
start runners**. Run the installation test in the checklist; finding a model alone does
not prove tasks will succeed. Other engines are covered in
[Run the local stack](run-local-stack.md).

## 2. Create a mission

Go to **Missions → New mission**. Pick a play, or describe the work in your own words.
Two starter plays are included:

| Play | Provide | You receive |
|---|---|---|
| Investigate an operational issue | The situation and known facts | Analysis, blockers, proposed next steps |
| Draft a support response | Ticket title and description | A response draft for review |

You can also run a single task from **Plays**. Review the inputs, then confirm. If
validation fails, fix the indicated fields; the form keeps your input. If a start
response is lost, confirm again on the same review to recover the existing run.

## 3. Plan, confirm, follow

Open the mission's **Plan** tab and review the proposed tasks. When you confirm the
plan, its tasks start automatically. If you prefer to approve each one, turn on the
mission setting **Ask me before each task** (`autoStart` off). _Pending merge: this
setting is not yet in the contracts on main; today tasks are started from the Plan
tab._

Follow progress on the **Live** tab, or the **Live** area for all sessions. Open a
session to steer or stop it. Use **Logs** to search what happened.

## 4. Review outputs and evidence

The **Outputs** tab lists what the mission produced. Open an output to see versions and
where it came from. Open the run for its evidence: the independent validation verdict.
These checks establish structure and allowed fields, not the accuracy of advice. The
starter plays send no messages and run no remediation, and their context tool uses
local demonstration data.

## 5. Close

When everything is verified, propose completion and close the mission from its page.

## Related

- An external action needs an approval: [Runs and approvals](operate-runs-and-approvals.md).
  An approval is not execution. If an outcome is unknown, reconcile before retrying.
- For a ticket or incident, open it from **Plays → Support** or **Incidents** and start
  a task for that item. The item lists related runs; completing a task does not
  approve an external action.
