import { BrainError, splitMemoryEntry, type MemoryProposal, type SnapshotManifest } from "@brain/contracts";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { append } from "../events";
import { newId, type AttemptRow } from "../tasks/store";
import { readArtifact } from "../trust/artifacts";
import { activate, activeManifest, commitFolder, getWorkspace, type Committed } from "../workspace/store";

/** A workspace's memory (docs/model.md): a search index over the entries and the text documents of its active snapshot, and entries agents propose for a person to accept. */

/** Rebuilds a workspace's index from the memory entries of the snapshot being activated. */
function indexMemory(gov: Gov, workspaceId: string, manifest: SnapshotManifest): void {
  gov.db.prepare("DELETE FROM memory_index WHERE workspace_id=?").run(workspaceId);
  for (const entry of manifest.memory) {
    const { title, body } = splitMemoryEntry(new TextDecoder().decode(readArtifact(gov, entry.digest)));
    gov.db.prepare("INSERT INTO memory_index(workspace_id, name, title, body) VALUES (?,?,?,?)").run(workspaceId, entry.name, title, body);
  }
  // A document is told from a memory entry by its name: an entry's is a slug, a document's is its path.
  for (const document of manifest.documents) {
    const { body } = splitMemoryEntry(new TextDecoder().decode(readArtifact(gov, document.digest)));
    gov.db.prepare("INSERT INTO memory_index(workspace_id, name, title, body) VALUES (?,?,?,?)").run(workspaceId, document.path, document.title, body);
  }
}

/** The entries that best match the words of a query, best first, each with the part of it that matches. */
export function searchMemory(db: Db, workspaceId: string, query: string, limit = 5): Array<{ name: string; title: string; text: string; source: "memory" | "document" }> {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const rows = db.prepare(`SELECT name, title, snippet(memory_index, 3, '', '', ' ... ', 64) AS text FROM memory_index WHERE memory_index MATCH ? AND workspace_id=?
    ORDER BY bm25(memory_index, 0.0, 0.0, 4.0, 1.0) LIMIT ?`).all(words.slice(0, 20).map((word) => `"${word}"*`).join(" OR "), workspaceId, Math.min(Math.max(limit, 1), 20)) as Array<{ name: string; title: string; text: string }>;
  return rows.map((row) => ({ ...row, source: row.name.includes("/") ? "document" : "memory" }));
}

/** Records an entry an agent proposes. Nothing is saved to the workspace until a person accepts it. */
export function proposeMemory(gov: Gov, attempt: AttemptRow, input: { name: string; title: string; text: string }): string {
  const id = newId("mp");
  gov.db.prepare("INSERT INTO memory_proposals(id, workspace_id, name, title, body, task_id, attempt_id, proposed_by, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, attempt.workspace_id, input.name, input.title, input.text, attempt.task_id, attempt.id, attempt.agent, gov.clock.nowMs());
  append(gov.db, { type: "memory.proposed", workspaceId: attempt.workspace_id, subject: `memory:${input.name}`, payload: { proposalId: id, name: input.name, title: input.title }, actor: { kind: "agent", id: attempt.agent, attemptId: attempt.id } });
  return id;
}

export function registerMemory({ gov }: Governor): void {
  const { registry } = gov;
  gov.onActivate.push((workspaceId, manifest) => indexMemory(gov, workspaceId, manifest));

  registry.query("memory.list", (ctx, input) => ({
    entries: activeManifest(ctx.gov, input.workspaceId).memory.map((entry) => ({ name: entry.name, title: entry.title, titles: entry.titles, source: entry.source })),
    proposals: ctx.db.prepare(`SELECT id, name, title, body, proposed_by AS proposedBy, task_id AS taskId, state, created_at_ms AS at FROM memory_proposals WHERE workspace_id=?
      ORDER BY state='pending' DESC, created_at_ms DESC LIMIT 200`).all(input.workspaceId) as MemoryProposal[],
  }));

  interface ProposalRow { name: string; title: string; body: string; state: string }
  const pending = (db: Db, workspaceId: string, proposalId: string): ProposalRow => {
    const row = db.prepare("SELECT name, title, body, state FROM memory_proposals WHERE id=? AND workspace_id=?").get(proposalId, workspaceId) as ProposalRow | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "Proposal not found");
    if (row.state !== "pending") throw new BrainError("CONFLICT", `This proposal is already ${row.state}`);
    return row;
  };
  // Accepting writes memory/<name>.md through the same validated commit as any other change to the workspace's files.
  registry.command<"memory.decide", Committed | undefined>("memory.decide", {
    async prepare(ctx, input) {
      const proposal = pending(ctx.db, input.workspaceId, input.proposalId);
      if (input.decision === "reject") return undefined;
      const content = new TextEncoder().encode(`# ${proposal.title}\n\n${proposal.body.trim()}\n`);
      return commitFolder(ctx.gov, getWorkspace(ctx.db, input.workspaceId).slug, {
        write: new Map([[`memory/${proposal.name}.md`, content]]), remove: [], message: `Accept the memory entry ${proposal.name}`, author: { name: ctx.user?.name ?? "Brain", email: ctx.user?.email ?? "brain@localhost" },
      });
    },
    run(ctx, input, committed) {
      const proposal = pending(ctx.db, input.workspaceId, input.proposalId);
      const state = committed ? "accepted" : "rejected";
      ctx.db.prepare("UPDATE memory_proposals SET state=?, decided_by=?, decided_at_ms=? WHERE id=?").run(state, ctx.actor.id, ctx.now(), input.proposalId);
      append(ctx.db, { type: `memory.${state}`, workspaceId: input.workspaceId, subject: `memory:${proposal.name}`, payload: { proposalId: input.proposalId, name: proposal.name }, actor: ctx.actor });
      if (committed) activate(ctx.gov, ctx.db, input.workspaceId, committed, ctx.actor, "workspace.changed");
      return { commit: committed?.commit ?? null };
    },
  });
}
