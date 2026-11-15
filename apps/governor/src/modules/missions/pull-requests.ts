import type { GitProvider, PullRequest, PullRequestObservation, PullRequestState } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

type Db = ReturnType<Store["workspaceDb"]>;
type Row = {
  id: string; approval_id: string; invocation_id: string; run_id: string | null; work_item_id: string | null; mission_id: string | null; connection_id: string;
  provider: GitProvider; repository_key: string; number: number; url: string; title: string; branch: string; base_branch: string; commit_oid: string; opened_at_ms: number;
};
type StateRow = { pull_request_id: string; state: PullRequestState; source: "opened" | "refresh"; observed_by: string | null; observed_at_ms: number };

const WORDS: Readonly<Record<PullRequestState, string>> = { open: "open", merged: "merged", closed: "closed without merging" };

/**
 * Keeps a pull request an approved change opened as a record (#121, ADR 0044). The record is written once, from what the Governor itself got
 * back from the provider, and is never edited: where the request stands later is a new observation beside the first one. It is linked to
 * the work item the run serves (when there is one) and to the approval it came from, so the work item and the approval history both show it.
 * Writing it again for the same approval changes nothing, which makes a retry or a restart safe.
 */
export function recordPullRequest(store: Store, db: Db, input: {
  organizationId: string; workspaceId: string; approvalId: string; invocationId: string; runId: string | undefined;
  opened: { url: string; number: number; branch: string; base: string; commit: string; provider: GitProvider; connectionId: string; repositoryKey: string }; title: string;
}): { pullRequestId: string; created: boolean } {
  const prior = db.prepare("SELECT id FROM pull_requests WHERE approval_id=?").get(input.approvalId) as { id: string } | undefined;
  if (prior) return { pullRequestId: prior.id, created: false };
  const link = input.runId ? db.prepare("SELECT mission_id, work_item_id FROM execution_links WHERE run_id=? ORDER BY created_at_ms DESC LIMIT 1").get(input.runId) as { mission_id: string; work_item_id: string } | undefined : undefined;
  const id = store.id("pr");
  const now = store.now();
  store.inTx(db, () => {
    db.prepare(`INSERT INTO pull_requests(id,approval_id,invocation_id,run_id,work_item_id,mission_id,connection_id,provider,repository_key,number,url,title,branch,base_branch,commit_oid,opened_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.approvalId, input.invocationId, input.runId ?? null, link?.work_item_id ?? null, link?.mission_id ?? null, input.opened.connectionId, input.opened.provider, input.opened.repositoryKey, input.opened.number, input.opened.url, input.title.slice(0, 200), input.opened.branch, input.opened.base, input.opened.commit, now);
    // Opening it is the first thing known about its state: the provider answered 201 for a request that is open.
    db.prepare("INSERT INTO pull_request_states(id,pull_request_id,state,source,observed_by,observed_at_ms) VALUES (?,?,'open','opened',NULL,?)").run(store.id("prs"), id, now);
  });
  store.emit(store.control, {
    organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "approval", aggregateId: input.approvalId, eventType: "pullRequest.opened",
    payload: { approvalId: input.approvalId, pullRequestId: id, message: `A pull request was opened: ${input.opened.url}` },
  });
  return { pullRequestId: id, created: true };
}

/** What a refresh needs to ask the provider again: which request, and through which connection it was opened. */
export function pullRequestRef(db: Db, pullRequestId: string): { connectionId: string; provider: GitProvider; repositoryKey: string; number: number } {
  const row = db.prepare("SELECT connection_id, provider, repository_key, number FROM pull_requests WHERE id=?").get(pullRequestId) as Pick<Row, "connection_id" | "provider" | "repository_key" | "number"> | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "pull request not found");
  return { connectionId: row.connection_id, provider: row.provider, repositoryKey: row.repository_key, number: row.number };
}

/**
 * Adds what a look at the provider found. Earlier rows are never touched: the newest one is the current state and the first one stays
 * the state at the time it was opened. A change of state is also said in the approval's history; a look that found nothing new is not.
 */
export function observePullRequest(store: Store, db: Db, input: { organizationId: string; workspaceId: string; pullRequestId: string; state: PullRequestState; observedBy: string }): { changed: boolean } {
  const row = db.prepare("SELECT approval_id, url FROM pull_requests WHERE id=?").get(input.pullRequestId) as { approval_id: string; url: string } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "pull request not found");
  const latest = db.prepare("SELECT state FROM pull_request_states WHERE pull_request_id=? ORDER BY observed_at_ms DESC, rowid DESC LIMIT 1").get(input.pullRequestId) as { state: PullRequestState } | undefined;
  db.prepare("INSERT INTO pull_request_states(id,pull_request_id,state,source,observed_by,observed_at_ms) VALUES (?,?,?,'refresh',?,?)").run(store.id("prs"), input.pullRequestId, input.state, input.observedBy, store.now());
  const changed = latest?.state !== input.state;
  if (changed) {
    store.emit(store.control, {
      organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "approval", aggregateId: row.approval_id, eventType: "pullRequest.stateObserved",
      payload: { approvalId: row.approval_id, pullRequestId: input.pullRequestId, state: input.state, actorId: input.observedBy, message: `The pull request is now ${WORDS[input.state]}: ${row.url}` },
    });
  }
  return { changed };
}

/** The pull requests of one work item or of one approval (the two never share an id), oldest first, each with every observation of its state. */
export function listPullRequests(db: Db, key: string): PullRequest[] {
  const rows = db.prepare("SELECT * FROM pull_requests WHERE work_item_id=? OR approval_id=? ORDER BY opened_at_ms, id LIMIT 50").all(key, key) as Row[];
  return rows.map((row): PullRequest => {
    const observations = (db.prepare("SELECT * FROM (SELECT *, rowid AS r FROM pull_request_states WHERE pull_request_id=? ORDER BY observed_at_ms DESC, rowid DESC LIMIT 100) ORDER BY observed_at_ms, r").all(row.id) as StateRow[])
      .map((entry): PullRequestObservation => ({ state: entry.state, source: entry.source, ...(entry.observed_by ? { observedBy: entry.observed_by } : {}), observedAt: iso(entry.observed_at_ms) }));
    const current = observations[observations.length - 1]!;
    return {
      pullRequestId: row.id, approvalId: row.approval_id, ...(row.work_item_id ? { workItemId: row.work_item_id } : {}), ...(row.mission_id ? { missionId: row.mission_id } : {}), ...(row.run_id ? { runId: row.run_id } : {}),
      provider: row.provider, repository: row.repository_key, number: row.number, url: row.url, title: row.title, branch: row.branch, base: row.base_branch, openedAt: iso(row.opened_at_ms),
      state: current.state, stateObservedAt: current.observedAt, observations,
    };
  });
}
