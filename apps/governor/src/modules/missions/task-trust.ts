import type { Mission } from "@brain/contracts";
import type { Store } from "../../application/store";
import { trustForBundle } from "../evidence/index";

type Db = ReturnType<Store["workspaceDb"]>;

/**
 * The mission-level trust line: across the mission's tasks, how many finished work was checked by an independent reviewer
 * (tests, files or hashes), how many rest on a person's sign-off and how many on a model's opinion alone. It is derived from the
 * same per-task trust read the Result cards show, so the totals and the cards cannot disagree. Absent until a task is done.
 */
export function missionTaskTrust(store: Store, organizationId: string, db: Db, missionId: string): Mission["taskTrust"] | undefined {
  const items = db.prepare("SELECT state, evidence_digest FROM work_items WHERE mission_id=? AND state!='abandoned'").all(missionId) as Array<{ state: string; evidence_digest: string | null }>;
  const done = items.filter((item) => item.state === "done" && item.evidence_digest);
  if (done.length === 0) return undefined;
  let reviewer = 0;
  let human = 0;
  let model = 0;
  for (const item of done) {
    const trust = trustForBundle(store, organizationId, db, item.evidence_digest!);
    if (!trust) continue;
    if (trust.model > 0) model += 1;
    else if (trust.human > 0) human += 1;
    else reviewer += 1;
  }
  const tasks = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
  return { total: items.length, reviewer, human, model, text: `${reviewer} of ${tasks(items.length)} checked by an independent reviewer; ${human} by human sign-off; ${model} model opinion only` };
}
