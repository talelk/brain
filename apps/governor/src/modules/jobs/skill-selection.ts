import { releaseRecord } from "../configuration/index";
import type { Store } from "../../application/store";

/** What a job's step asks of its agent, as the prompt will say it: the step's own brief, else the situation, else its input. */
export function promptTaskText(payload: { step?: { task?: string }; input?: unknown }): string {
  const situation = (payload.input as { situation?: unknown } | null | undefined)?.situation;
  return payload.step?.task ?? (typeof situation === "string" ? situation : JSON.stringify(payload.input ?? {}));
}

/** A skill the Governor chose for one job: the pinned release document's digest and text, and the trigger words of the task that matched. */
export interface SelectedSkill { id: string; digest: string; text: string; matched: string[] }

/** Rough tokens the selected skills add to the prompt (4 bytes a token, as the rest of the prompt budget counts). */
export const skillTokens = (skills: ReadonlyArray<{ text: string }> | undefined): number => Math.ceil((skills ?? []).reduce((sum, skill) => sum + skill.text.length, 0) / 4);

/**
 * Skills load on demand. An agent pins the skills it may use (its release document names each by digest); at the first offer of one
 * of its jobs the Governor loads those whose trigger words the task names and freezes them into the job payload, so the execution
 * artifact holds exactly what the runner adds to the agent's instructions and a repeat claim sees the same bytes. A task that names no
 * trigger loads nothing. This only ever adds text: the tools an agent may call stay what its own release document lists.
 */
export function ensureSkills(s: Store, organizationId: string, job: Record<string, unknown>): void {
  const jobId = String(job["id"]);
  const row = s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string } | undefined;
  if (!row) return;
  const payload = JSON.parse(row.payload_json) as { step?: { task?: string; uses?: { type?: string; release?: { id: string } } }; input?: unknown; skills?: SelectedSkill[] };
  const agentId = payload.step?.uses?.type === "agent" ? payload.step.uses.release?.id : undefined;
  if (!agentId || payload.skills) return;
  // A job whose execution artifact is already pinned keeps exactly those bytes.
  if (s.control.prepare("SELECT 1 FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(`exec-${jobId}`, organizationId)) return;
  const release = releaseRecord(s, organizationId, String(job["config_digest"]))?.release;
  const pinned = release?.agents?.[agentId]?.spec.skills ?? [];
  if (pinned.length === 0) return;
  const task = promptTaskText(payload).toLowerCase();
  const selected: SelectedSkill[] = [];
  for (const ref of pinned) {
    const skill = release?.skills?.[ref.id];
    // The release pinned this digest at compilation; one that no longer matches is never loaded.
    if (!skill || skill.digest !== ref.digest) continue;
    const matched = skill.triggers.filter((trigger) => task.includes(trigger.toLowerCase()));
    if (matched.length > 0) selected.push({ id: ref.id, digest: skill.digest, text: skill.text, matched });
  }
  if (selected.length === 0) return;
  payload.skills = selected;
  s.control.prepare("UPDATE job_payloads SET payload_json=? WHERE job_id=?").run(JSON.stringify(payload), jobId);
}
