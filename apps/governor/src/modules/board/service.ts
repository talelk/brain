import type { ActorContext, CommandEnvelope, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { WorkService } from "../work/service";

/**
 * The board module owns the Kanban view over work items and the decision
 * surface that judges them. Cards were unified into work items (issue #2):
 * board state is work-item state, and the board read model is the single
 * projection of objectives, work items and their execution links.
 */
export class BoardService {
  constructor(private readonly store: Store, private readonly work: WorkService) {}

  apply(actor: ActorContext, cmd: CommandEnvelope & { payload: Record<string, unknown> }, workspaceId: string): string {
    if (cmd.commandType !== "decision.record") throw new BrainDomainError("INVALID_CONTRACT", `unsupported board command ${cmd.commandType}`);
    const p = cmd.payload;
    const ws = this.store.workspaceDb(workspaceId, actor.organizationId);
    const workItemId = String(p["workItemId"]);
    if (!ws.prepare("SELECT 1 FROM work_items WHERE id=?").get(workItemId)) throw new BrainDomainError("NOT_FOUND", "work item not found");
    const id = this.store.id("dec");
    ws.prepare("INSERT INTO decisions(id, work_item_id, actor_id, decision, note, created_at_ms) VALUES (?,?,?,?,?,?)")
      .run(id, workItemId, actor.actorId, String(p["decision"]), String(p["note"] ?? ""), this.store.now());
    return id;
  }

  query(actor: ActorContext, workspaceId: string): JsonValue {
    const ws = this.store.workspaceDb(workspaceId, actor.organizationId);
    const projection = this.work.projectBoard(actor, workspaceId);
    const executions = (ws.prepare("SELECT * FROM execution_links ORDER BY created_at_ms DESC,run_id LIMIT 1000").all() as Array<{ work_item_id: string; run_id: string; job_id: string | null; attempt_id: string | null; session_id: string | null; created_at_ms: number }>).map((row) => ({
      workItemId: row.work_item_id, runId: row.run_id,
      ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), createdAt: iso(row.created_at_ms),
    }));
    return { workspaceId, objectives: projection.objectives, items: projection.items, executions } as unknown as JsonValue;
  }
}
