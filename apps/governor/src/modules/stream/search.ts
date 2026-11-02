import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import type { ActorContext } from "@brain/contracts";
import { rowToView, scopeFor, filterClauses, SEARCH_LIMIT, type StreamFilters, type StreamRecordView } from "./query";

/**
 * Full-text search over the bounded stream summaries. The FTS index is
 * standalone-content (document_fts precedent), joined back to the scoped
 * execution_stream rows so authorization filtering happens in SQL before the
 * page limit. Pages run descending (newest first); `nextCursor` — the page's
 * oldest stream_seq — feeds the `before` bound to fetch the next, older page.
 */

const MAX_TOKENS = 16;

/** Quote every token so punctuation in log text cannot act as FTS syntax. */
export function matchQuery(search: string): string {
  const tokens = search.split(/\s+/u).map((token) => token.replace(/^"|"$/gu, "")).filter((token) => token.length > 0).slice(0, MAX_TOKENS);
  if (tokens.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "search text required");
  return tokens.map((token) => `"${token.replace(/"/gu, "")}"`).join(" ");
}

export interface StreamSearchResult {
  items: StreamRecordView[];
  totalEstimate: number;
  /** Oldest stream_seq of this page; pass as the exclusive `before` bound to page older matches. */
  nextCursor: number | "";
}

export function searchStream(store: Store, actor: ActorContext, params: StreamFilters & { search: string }, rawLimit?: number): StreamSearchResult {
  const limit = Math.min(Math.max(Math.floor(rawLimit ?? 30) || 30, 1), SEARCH_LIMIT);
  const match = matchQuery(params.search);
  const scope = scopeFor(store, actor, params.workspaceId);
  const filter = filterClauses(params);
  const clauses = ["execution_stream_fts MATCH ?", scope.clause, ...filter.clauses];
  const parameters: Array<string | number> = [match, ...scope.params, ...filter.params];
  const where = clauses.join(" AND ");
  const rows = store.control.prepare(`SELECT s.* FROM execution_stream_fts f JOIN execution_stream s ON s.stream_seq=f.stream_seq
    WHERE ${where} ORDER BY s.stream_seq DESC LIMIT ?`).all(...parameters, limit) as Array<Parameters<typeof rowToView>[0]>;
  const items = rows.map(rowToView);
  const totalEstimate = Number((store.control.prepare(`SELECT COUNT(*) AS c FROM execution_stream_fts f JOIN execution_stream s ON s.stream_seq=f.stream_seq
    WHERE ${where}`).get(...parameters) as { c: number }).c);
  return {
    items,
    totalEstimate,
    nextCursor: items.length === limit && items.length > 0 ? items[items.length - 1]!.streamSeq : "",
  };
}
