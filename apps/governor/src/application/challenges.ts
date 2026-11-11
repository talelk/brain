import type { ActorContext, CommandReceipt, JsonValue, WorkflowCatalogEntry } from "@brain/contracts";
import { payloadValidator } from "@brain/contracts/validate";
import { handlersFor, type CommandHandlers } from "./command-funnel";
import { requireWorkspaceRead } from "./authz";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";
import { iso } from "../domain/clock";
import type { MissionService } from "../modules/missions/index";
import { GENERAL_TASK_WORKFLOW, workItemSituation } from "../modules/workflows/index";

/** A challenge that has not finished after this long is reported as failed, never left spinning. */
const CHALLENGE_TIMEOUT_MS = 30 * 60_000;
const MAX_CLAIMS = 10;
const CLAIM_CHARS = 600;

/**
 * What the reviewer is asked, as the acceptance criteria of one ordinary task. The reviewer reads the result as quoted data; it
 * is asked for weak points, not for a verdict, and nothing it writes is ever consulted by the done gate (ADR 0012).
 */
export const CHALLENGE_CRITERIA: readonly string[] = [
  "Lists up to five specific claims in the reviewed result that are unsupported, wrong, unclear or missing evidence, one per bullet line starting with '- ', each naming the part of the result it is about.",
  "For each claim, says in one sentence what evidence or check would settle it.",
  "If no claim looks weak, says so plainly instead of inventing one.",
];

export interface ChallengeClaim { readonly text: string }
export interface ChallengeView {
  readonly challengeId: string;
  readonly workItemId: string;
  readonly state: "requested" | "running" | "done" | "failed";
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly completedAt?: string;
  /** What the reviewer concluded, in its own words. A model opinion, labelled as such everywhere it is shown. */
  readonly summary?: string;
  readonly claims: readonly ChallengeClaim[];
  readonly reason?: string;
  readonly runId?: string;
  readonly independence: "L1";
}

interface Row {
  id: string; work_item_id: string; run_id: string | null; requested_by: string; state: ChallengeView["state"]; summary: string | null; claims_json: string;
  reason: string | null; created_at_ms: number; completed_at_ms: number | null;
}

interface Ports {
  readonly store: Store;
  readonly missions: MissionService;
  dispatch(actor: ActorContext, command: unknown): Promise<{ receipt: CommandReceipt }>;
  catalog(organizationId: string): readonly WorkflowCatalogEntry[];
}

const viewOf = (row: Row): ChallengeView => ({
  challengeId: row.id, workItemId: row.work_item_id, state: row.state, requestedBy: row.requested_by, requestedAt: iso(row.created_at_ms),
  ...(row.completed_at_ms !== null ? { completedAt: iso(row.completed_at_ms) } : {}), ...(row.summary ? { summary: row.summary } : {}),
  claims: JSON.parse(row.claims_json) as ChallengeClaim[], ...(row.reason ? { reason: row.reason } : {}), ...(row.run_id ? { runId: row.run_id } : {}), independence: "L1",
});

/** The bullet and numbered lines of the reviewer's written answer are its claims; anything else stays in the summary. */
export function claimsOf(deliverable: string): ChallengeClaim[] {
  const claims: ChallengeClaim[] = [];
  for (const line of deliverable.split("\n")) {
    const match = /^\s*(?:[-*]|\d+[.)])\s+(.{3,})$/u.exec(line);
    if (match) claims.push({ text: match[1]!.replace(/\s+/gu, " ").trim().slice(0, CLAIM_CHARS) });
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

/**
 * "Challenge this result" (issue #50, ADR 0012). A challenge is an ordinary governed run of the general task workflow (its
 * task-worker agent, checked by the same task.validate evaluator) that reads the finished result as data and writes what looks
 * weak. The run is bound to no work item: it can never be an attempt, change a task's state, evidence or verdict, or move the
 * mission. Its findings are stored as claims beside the result, always labelled as one model's opinion.
 *
 * The command only records the request; the sweep starts the run (one id per challenge, so a replay starts nothing twice) and
 * later collects its answer, so a crash at any point leaves a request that the next pass finishes.
 */
export class Challenges {
  private sweeping: Promise<void> | undefined;
  constructor(private readonly ports: Ports) {}

  commands(): CommandHandlers {
    const { store, missions } = this.ports;
    return handlersFor(["result.challenge"], {
      kind: "workspace",
      handle: ({ actor, cmd, workspaceId }) => {
        requireWorkspaceRead(store, actor, workspaceId);
        const db = store.workspaceDb(workspaceId, actor.organizationId);
        const workItemId = String(cmd.payload["workItemId"]);
        const result = missions.resultOf(actor, workspaceId, workItemId);
        if (result.state !== "done" && result.state !== "review") throw new BrainDomainError("CONFLICT", "only a finished task's result can be challenged");
        if (!result.deliverable) throw new BrainDomainError("EVIDENCE_MISSING", "this task has no written result to challenge");
        if (result.spendCapReached) throw new BrainDomainError("BUDGET_EXHAUSTED", "the workspace spend cap is reached; raise it before asking a reviewer to read this result");
        if (result.missionBudgetReached) throw new BrainDomainError("BUDGET_EXHAUSTED", "the mission's budget is spent; raise it before asking a reviewer to read this result");
        if (db.prepare("SELECT 1 FROM result_challenges WHERE work_item_id=? AND state IN ('requested','running')").get(workItemId)) throw new BrainDomainError("CONFLICT", "a challenge of this result is already in progress");
        const id = store.id("challenge");
        db.prepare("INSERT INTO result_challenges(id,work_item_id,requested_by,state,created_at_ms) VALUES (?,?,?, 'requested', ?)").run(id, workItemId, actor.actorId, store.now());
        store.emit(db, { workspaceId, aggregateType: "challenge", aggregateId: id, eventType: "challenge.requested", payload: { challengeId: id, workItemId, requestedBy: actor.actorId } });
        return { resourceId: id };
      },
    });
  }

  list(actor: ActorContext, workspaceId: string, workItemId?: string, limit = 50): { items: ChallengeView[] } {
    requireWorkspaceRead(this.ports.store, actor, workspaceId);
    const db = this.ports.store.workspaceDb(workspaceId, actor.organizationId);
    const rows = (workItemId
      ? db.prepare("SELECT * FROM result_challenges WHERE work_item_id=? ORDER BY created_at_ms DESC, id LIMIT ?").all(workItemId, limit)
      : db.prepare("SELECT * FROM result_challenges ORDER BY created_at_ms DESC, id LIMIT ?").all(limit)) as Row[];
    return { items: rows.map(viewOf) };
  }

  /** Starts requested challenges and collects finished ones, for every active workspace (maintenance pass) or for one. */
  sweep(organizationId?: string, workspaceId?: string): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      try {
        const targets = (workspaceId && organizationId ? [{ id: workspaceId, organization_id: organizationId }]
          : this.ports.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE status='active'").all() as Array<{ id: string; organization_id: string }>);
        for (const ws of targets) {
          try { await this.pass(ws.organization_id, ws.id); } catch { /* the next pass retries */ }
        }
      } finally { this.sweeping = undefined; }
    })();
    return this.sweeping;
  }

  private async pass(organizationId: string, workspaceId: string): Promise<void> {
    const { store } = this.ports;
    const db = store.workspaceDb(workspaceId, organizationId);
    for (const row of db.prepare("SELECT * FROM result_challenges WHERE state IN ('requested','running') ORDER BY created_at_ms").all() as Row[]) {
      if (row.state === "requested") await this.start(organizationId, workspaceId, row);
      else this.collect(db, row);
    }
  }

  private fail(db: ReturnType<Store["workspaceDb"]>, id: string, reason: string): void {
    db.prepare("UPDATE result_challenges SET state='failed', reason=?, completed_at_ms=? WHERE id=? AND state IN ('requested','running')").run(reason.slice(0, 500), this.ports.store.now(), id);
  }

  private async start(organizationId: string, workspaceId: string, row: Row): Promise<void> {
    const { store, missions } = this.ports;
    const db = store.workspaceDb(workspaceId, organizationId);
    const actor: ActorContext = { kind: "workflow", actorId: row.requested_by, organizationId, workspaceId, scopes: ["workflow:dispatch"], authMethod: "service-credential", authGeneration: 1 };
    const reviewer = { ...actor, kind: "human" as const, scopes: ["workspace:read"], authMethod: "session" as const };
    let situation: string;
    try {
      const result = missions.resultOf(reviewer, workspaceId, row.work_item_id);
      if (!result.deliverable) { this.fail(db, row.id, "the result has no written text to review"); return; }
      if (result.spendCapReached) { this.fail(db, row.id, "the workspace spend cap is reached"); return; }
      if (result.missionBudgetReached) { this.fail(db, row.id, "the mission's budget is spent"); return; }
      situation = workItemSituation(`Challenge the result of the task "${result.title}"`, CHALLENGE_CRITERIA, [{ title: result.title, summary: `The result under review, written by another run for the task "${result.title}".`, deliverable: result.deliverable }], true);
    } catch (error) { this.fail(db, row.id, error instanceof Error ? error.message : "the result could not be read"); return; }
    const entry = this.ports.catalog(organizationId).find((candidate) => candidate.release.id === GENERAL_TASK_WORKFLOW);
    if (!entry?.inputSchema) { this.fail(db, row.id, "the active release has no general task workflow to run a challenge with"); return; }
    const input: JsonValue = { situation };
    const valid = payloadValidator(entry.inputSchema as object)(input);
    if (!valid.ok) { this.fail(db, row.id, `the challenge brief does not fit the workflow: ${valid.errors.join("; ")}`); return; }
    const commandId = `challenge-${row.id}`;
    try {
      const { receipt } = await this.ports.dispatch(actor, { contractVersion: "brain.command/v1", commandId, idempotencyKey: commandId, commandType: "workflow.dispatch", workspaceId, payload: { workflow: entry.release, input } });
      if (!receipt.accepted || !receipt.resourceId) { this.fail(db, row.id, "the reviewer run was not accepted"); return; }
      db.prepare("UPDATE result_challenges SET state='running', run_id=? WHERE id=? AND state='requested'").run(receipt.resourceId, row.id);
    } catch (error) {
      if (!(error instanceof BrainDomainError)) throw error;
      this.fail(db, row.id, `the reviewer run could not start: ${error.message}`);
    }
  }

  private collect(db: ReturnType<Store["workspaceDb"]>, row: Row): void {
    if (!row.run_id) { this.fail(db, row.id, "the reviewer run was never recorded"); return; }
    const run = db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(row.run_id) as { state: string } | undefined;
    if (!run) { this.fail(db, row.id, "the reviewer run is gone"); return; }
    if (run.state === "succeeded") {
      const output = db.prepare("SELECT output_json FROM step_outputs WHERE run_id=? AND step_id='respond'").get(row.run_id) as { output_json: string } | undefined;
      let parsed: { summary?: unknown; deliverable?: unknown } = {};
      try { parsed = output ? JSON.parse(output.output_json) as typeof parsed : {}; } catch { /* an unreadable answer is a failure below */ }
      const deliverable = typeof parsed.deliverable === "string" ? parsed.deliverable : "";
      if (!deliverable.trim()) { this.fail(db, row.id, "the reviewer returned no written answer"); return; }
      const claims = claimsOf(deliverable);
      const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 1500) : "";
      this.ports.store.inTx(db, () => {
        db.prepare("UPDATE result_challenges SET state='done', summary=?, claims_json=?, completed_at_ms=? WHERE id=? AND state='running'").run(summary || null, JSON.stringify(claims), this.ports.store.now(), row.id);
        this.ports.store.emit(db, { aggregateType: "challenge", aggregateId: row.id, eventType: "challenge.completed", payload: { challengeId: row.id, workItemId: row.work_item_id, claims: claims.length } });
      });
    } else if (run.state === "failed" || run.state === "cancelled") this.fail(db, row.id, `the reviewer run ${run.state}`);
    else if (this.waitingForBudget(row.run_id)) {
      // The budget ran out after the request: say so now, and stop the run so it cannot start (and spend) once the budget is raised.
      this.fail(db, row.id, "the mission's budget or the workspace spend cap ran out before the reviewer could start");
      void this.cancel(db, row.run_id);
    } else if (this.ports.store.now() - row.created_at_ms > CHALLENGE_TIMEOUT_MS) this.fail(db, row.id, "the reviewer did not answer in time");
  }

  private waitingForBudget(runId: string): boolean {
    return Boolean(this.ports.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND queue_reason='waiting: budget' AND state IN ('queued','blocked')").get(runId));
  }

  private async cancel(db: ReturnType<Store["workspaceDb"]>, runId: string): Promise<void> {
    const row = db.prepare("SELECT c.requested_by, c.id FROM result_challenges c WHERE c.run_id=?").get(runId) as { requested_by: string; id: string } | undefined;
    if (!row) return;
    const organizationId = (this.ports.store.control.prepare("SELECT organization_id FROM jobs WHERE workflow_run_id=? LIMIT 1").get(runId) as { organization_id: string } | undefined)?.organization_id;
    const workspaceId = (this.ports.store.control.prepare("SELECT workspace_id FROM jobs WHERE workflow_run_id=? LIMIT 1").get(runId) as { workspace_id: string } | undefined)?.workspace_id;
    if (!organizationId || !workspaceId) return;
    const actor: ActorContext = { kind: "workflow", actorId: row.requested_by, organizationId, workspaceId, scopes: ["workflow:cancel"], authMethod: "service-credential", authGeneration: 1 };
    const commandId = `challenge-cancel-${row.id}`;
    try { await this.ports.dispatch(actor, { contractVersion: "brain.command/v1", commandId, idempotencyKey: commandId, commandType: "workflow.cancel", workspaceId, payload: { runId } }); }
    catch { /* the run is already failed for the person; the budget gate still holds an uncancelled run */ }
  }
}
