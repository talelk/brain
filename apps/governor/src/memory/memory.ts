import { BrainError, conceptText, isStale, readConcept, splitTitle, type ConceptFacts, type Digest, type MemoryProposal, type SnapshotManifest, type TrustTier } from "@brain/contracts";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { append } from "../events";
import { newId, type AttemptRow } from "../tasks/store";
import { readArtifact } from "../trust/artifacts";
import { activate, activeManifest, actorName, commitFolder, commitOf, getWorkspace, type Committed } from "../workspace/store";

/** A workspace's memory (docs/model.md): a search index over the entries and the text documents of its active snapshot, and entries agents propose for a person to accept. */

/** Rebuilds a workspace's index from the memory entries of the snapshot being activated. */
function indexMemory(gov: Gov, workspaceId: string, manifest: SnapshotManifest): void {
  gov.db.prepare("DELETE FROM memory_index WHERE workspace_id=?").run(workspaceId);
  const add = gov.db.prepare("INSERT INTO memory_index(workspace_id, name, title, body) VALUES (?,?,?,?)");
  /** What is searched of a file: a concept's description, body and tags, without the rest of its frontmatter. */
  const searched = (digest: Digest): { body: string } => {
    const text = new TextDecoder().decode(readArtifact(gov, digest));
    const read = readConcept(text);
    return { body: "problem" in read ? splitTitle(text).body : [read.facts.description, read.body, read.tags.join(" ")].filter(Boolean).join("\n\n") };
  };
  for (const entry of manifest.memory) add.run(workspaceId, entry.name, entry.title, searched(entry.digest).body);
  // A document is told from a memory entry by its name: an entry's is a slug, a document's is its path.
  for (const document of manifest.documents) add.run(workspaceId, document.path, document.title, searched(document.digest).body);
}

export type Found = {
  readonly name: string; readonly title: string; readonly text: string; readonly source: "memory" | "document";
  /** For a concept: what kind it is, who checked it, and, when it says so, that it is not stable or is to be checked again. */
  readonly type?: string; readonly trust?: TrustTier; readonly status?: string; readonly stale?: true;
};

/** The entries that best match the words of a query, best first, each with the part of it that matches. */
export function searchMemory(gov: Gov, workspaceId: string, query: string, limit = 5): Found[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const rows = gov.db.prepare(`SELECT name, title, snippet(memory_index, 3, '', '', ' ... ', 64) AS text FROM memory_index WHERE memory_index MATCH ? AND workspace_id=?
    ORDER BY bm25(memory_index, 0.0, 0.0, 4.0, 1.0) LIMIT ?`).all(words.slice(0, 20).map((word) => `"${word}"*`).join(" OR "), workspaceId, Math.min(Math.max(limit, 1), 20)) as Array<{ name: string; title: string; text: string }>;
  if (rows.length === 0) return [];
  const manifest = activeManifest(gov, workspaceId);
  const facts = new Map<string, ConceptFacts | undefined>([...manifest.memory.map((entry) => [entry.name, entry.concept] as const), ...manifest.documents.map((document) => [document.path, document.concept] as const)]);
  return rows.map((row) => {
    const concept = facts.get(row.name);
    return {
      ...row, source: row.name.includes("/") ? "document" : "memory",
      ...(concept ? { type: concept.type, trust: concept.trust, ...(concept.status ? { status: concept.status } : {}), ...(isStale(concept, gov.clock.nowMs()) ? { stale: true as const } : {}) } : {}),
    };
  });
}

const DEFAULT_TYPE = "Note";
/** A proposal's kind and text, as it is stored: a concept that holds nothing but its `type`. */
function proposed(stored: string): { type: string; body: string } {
  const read = readConcept(stored);
  return "problem" in read ? { type: DEFAULT_TYPE, body: stored.trim() } : { type: read.facts.type, body: read.body };
}

/** Records an entry an agent proposes. Nothing is saved to the workspace until a person accepts it. */
export function proposeMemory(gov: Gov, attempt: AttemptRow, input: { name: string; title: string; type?: string; text: string }): string {
  const id = newId("mp");
  gov.db.prepare("INSERT INTO memory_proposals(id, workspace_id, name, title, body, task_id, attempt_id, proposed_by, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, attempt.workspace_id, input.name, input.title, conceptText({ type: input.type?.trim() || DEFAULT_TYPE }, input.text), attempt.task_id, attempt.id, attempt.agent, gov.clock.nowMs());
  append(gov.db, { type: "memory.proposed", workspaceId: attempt.workspace_id, subject: `memory:${input.name}`, payload: { proposalId: id, name: input.name, title: input.title }, actor: { kind: "agent", id: attempt.agent, attemptId: attempt.id } });
  return id;
}

export function registerMemory({ gov }: Governor): void {
  const { registry } = gov;
  gov.onActivate.push((workspaceId, manifest) => indexMemory(gov, workspaceId, manifest));

  registry.query("memory.list", (ctx, input) => ({
    entries: activeManifest(ctx.gov, input.workspaceId).memory.map((entry) => ({ name: entry.name, title: entry.title, titles: entry.titles, ...(entry.concept ? { concept: entry.concept } : {}), source: entry.source })),
    proposals: (ctx.db.prepare(`SELECT id, name, title, body, proposed_by AS proposedBy, task_id AS taskId, state, created_at_ms AS at FROM memory_proposals WHERE workspace_id=?
      ORDER BY state='pending' DESC, created_at_ms DESC LIMIT 200`).all(input.workspaceId) as Array<Omit<MemoryProposal, "type">>).map((row) => ({ ...row, ...proposed(row.body) })),
  }));

  interface ProposalRow { name: string; title: string; body: string; state: string; proposedBy: string; at: number; snapshot: string | null }
  const pending = (db: Db, workspaceId: string, proposalId: string): ProposalRow => {
    const row = db.prepare(`SELECT p.name, p.title, p.body, p.state, p.proposed_by AS proposedBy, p.created_at_ms AS at, t.snapshot_digest AS snapshot FROM memory_proposals p LEFT JOIN tasks t ON t.id=p.task_id
      WHERE p.id=? AND p.workspace_id=?`).get(proposalId, workspaceId) as ProposalRow | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "Proposal not found");
    if (row.state !== "pending") throw new BrainError("CONFLICT", `This proposal is already ${row.state}`);
    return row;
  };
  // Accepting writes memory/<name>.md through the same validated commit as any other change to the workspace's files.
  registry.command<"memory.decide", Committed | undefined>("memory.decide", {
    async prepare(ctx, input) {
      const proposal = pending(ctx.db, input.workspaceId, input.proposalId);
      if (input.decision === "reject") return undefined;
      const author = { name: ctx.user?.name ?? "Brain", email: ctx.user?.email ?? "brain@localhost" };
      // The format's record of trust: the agent that wrote it, at the commit it ran on, and the person who checked it.
      const agent = proposal.snapshot === null ? proposal.proposedBy : `${proposal.proposedBy}/${commitOf(ctx.db, input.workspaceId, proposal.snapshot as Digest).slice(0, 12)}`;
      const { type, body } = proposed(proposal.body);
      const content = new TextEncoder().encode(conceptText({
        type, title: proposal.title, generated: { by: agent, at: new Date(proposal.at).toISOString() }, verified: [{ by: actorName(author, ""), at: new Date(ctx.now()).toISOString() }],
      }, body));
      return commitFolder(ctx.gov, getWorkspace(ctx.db, input.workspaceId).slug, {
        write: new Map([[`memory/${proposal.name}.md`, content]]), remove: [], instanceAdmin: false, message: `Accept the memory entry ${proposal.name}`, author,
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
