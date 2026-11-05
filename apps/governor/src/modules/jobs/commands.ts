import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { assertExpectedVersion } from "../../domain/states";
import type { JobProtocol } from "./job-protocol";

/** Jobs commands: runner administration, reconciliation requests and automations. */
export function jobCommands(store: Store, jobs: JobProtocol): CommandHandlers {
  const s = store;
  return {
    "runner.control": {
      kind: "control",
      handle: ({ actor, cmd }) => ({ resourceId: jobs.controlRunner(actor, { runnerId: String(cmd.payload["runnerId"]), action: String(cmd.payload["action"]), reason: String(cmd.payload["reason"]) }) }),
    },
    "job.reconcile": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        const jobId = String(cmd.payload["jobId"]);
        const job = s.control.prepare("SELECT state, version FROM jobs WHERE id=? AND organization_id=?").get(jobId, actor.organizationId) as { state: string; version: number } | undefined;
        if (!job) throw new BrainDomainError("NOT_FOUND", "job not found");
        if (job.state !== "outcome_unknown") throw new BrainDomainError("CONFLICT", "only outcome_unknown jobs can be reconciled");
        assertExpectedVersion(job.version, cmd.expectedVersion);
        const id = s.id("rec");
        s.control.prepare("INSERT INTO reconciliation_requests(id, job_id, command_id, expected_version, state, next_observation_at_ms, created_at_ms) VALUES (?,?,?,?, 'pending', ?,?)")
          .run(id, jobId, cmd.commandId, cmd.expectedVersion ?? job.version, s.now(), s.now());
        // Target observation and resolution run asynchronously from the request.
        return { outcome: "queued", resourceId: id };
      },
    },
    ...handlersFor(["automation.upsert", "automation.control"], {
      kind: "workspace",
      handle: ({ actor, cmd }) => ({ resourceId: jobs.automations.apply(actor, cmd as Parameters<JobProtocol["automations"]["apply"]>[1]) }),
    }),
  };
}
