import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Digest } from "@brain/contracts";
import type { ActorContext, Document, DocumentVersion, DocumentView, JsonValue, ResourceAssociation } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { assertExpectedVersion } from "../../domain/states";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

export interface DocumentStorage {
  put(digest: string, bytes: Uint8Array): void;
  read(digest: string): Uint8Array;
}

export class LocalDocumentStorage implements DocumentStorage {
  constructor(private readonly dataDir: string) {}

  private path(digest: string): string {
    const hex = digest.replace("sha256:", "");
    return join(this.dataDir, "cas", hex.slice(0, 2), hex);
  }

  put(digest: string, bytes: Uint8Array): void {
    if (sha256Digest(bytes) !== digest) throw new BrainDomainError("INVALID_CONTRACT", "document digest does not match its bytes");
    const path = this.path(digest);
    mkdirSync(join(path, ".."), { recursive: true });
    if (existsSync(path)) {
      const current = readFileSync(path);
      if (sha256Digest(current) !== digest) throw new BrainDomainError("CONFLICT", "document CAS content is corrupted");
      return;
    }
    writeFileSync(path, bytes, { flag: "wx" });
  }

  read(digest: string): Uint8Array {
    const path = this.path(digest);
    if (!existsSync(path)) throw new BrainDomainError("NOT_FOUND", "document bytes not found");
    const bytes = readFileSync(path);
    if (sha256Digest(bytes) !== digest) throw new BrainDomainError("CONFLICT", "document CAS content is corrupted");
    return bytes;
  }
}

export interface DocumentCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

type DocumentRow = {
  id: string; title: string; state: Document["state"]; current_version_id: string;
  created_by: string; version: number; created_at_ms: number; updated_at_ms: number;
};
type VersionRow = {
  id: string; document_id: string; revision: number; digest: string; bytes: number;
  media_type: string; file_name: string; extraction_status: DocumentVersion["extractionStatus"];
  extracted_text: string | null; created_by: string; created_at_ms: number;
};
type AssociationRow = {
  id: string; document_id: string; resource_kind: ResourceAssociation["resourceKind"];
  resource_id: string; created_by: string; created_at_ms: number;
};

const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const MEDIA_TYPES = new Set([...TEXT_MEDIA_TYPES, "application/pdf", "application/octet-stream"]);
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024;

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new BrainDomainError("INVALID_ARGUMENT", "document content must be canonical base64");
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES || Buffer.from(bytes).toString("base64") !== value) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "document content is empty, non-canonical or exceeds 8 MiB");
  return bytes;
}

function extract(mediaType: string, bytes: Uint8Array): { status: DocumentVersion["extractionStatus"]; text: string | null } {
  if (!TEXT_MEDIA_TYPES.has(mediaType)) return { status: "unsupported", text: null };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new BrainDomainError("INVALID_ARGUMENT", "text document is not valid UTF-8"); }
  if (/\0/u.test(text)) throw new BrainDomainError("INVALID_ARGUMENT", "text document contains NUL bytes");
  if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_BYTES) text = Buffer.from(text, "utf8").subarray(0, MAX_EXTRACTED_BYTES).toString("utf8");
  return { status: "ready", text };
}

function safeFileName(value: string): string {
  if (!value || value.length > 256 || value.includes("/") || value.includes("\\") || value.includes("\0") || value === "." || value === "..") throw new BrainDomainError("INVALID_ARGUMENT", "document fileName must be a plain file name");
  return value;
}

export class DocumentService {
  private readonly storage: DocumentStorage;

  constructor(private readonly store: Store, storage?: DocumentStorage) {
    this.storage = storage ?? new LocalDocumentStorage(store.dataDir);
  }

  private db(actor: ActorContext, workspaceId: string) {
    requireWorkspaceRead(this.store, actor, workspaceId);
    return this.store.workspaceDb(workspaceId, actor.organizationId);
  }

  private row(actor: ActorContext, workspaceId: string, id: string): DocumentRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM documents WHERE id=?").get(id) as DocumentRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "document not found");
    return row;
  }

  private static document(workspaceId: string, row: DocumentRow): Document {
    return {
      documentId: row.id, workspaceId, title: row.title, state: row.state, currentVersionId: row.current_version_id,
      createdBy: row.created_by, version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  private static version(row: VersionRow): DocumentVersion {
    return {
      documentVersionId: row.id, documentId: row.document_id, revision: row.revision, digest: row.digest,
      bytes: row.bytes, mediaType: row.media_type as DocumentVersion["mediaType"], fileName: row.file_name, extractionStatus: row.extraction_status,
      createdBy: row.created_by, createdAt: iso(row.created_at_ms),
    };
  }

  private static association(row: AssociationRow): ResourceAssociation {
    return {
      associationId: row.id, documentId: row.document_id, resourceKind: row.resource_kind,
      resourceId: row.resource_id, createdBy: row.created_by, createdAt: iso(row.created_at_ms),
    };
  }

  apply(actor: ActorContext, command: DocumentCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    switch (command.commandType) {
      case "document.upload": return this.upload(actor, workspaceId, command.payload);
      case "document.revise": return this.revise(actor, workspaceId, command.payload, command.expectedVersion);
      case "document.associate": return this.associate(actor, workspaceId, command.payload);
      case "document.delete": return this.revoke(actor, workspaceId, command.payload, command.expectedVersion);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported document command ${command.commandType}`);
    }
  }

  private upload(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.db(actor, workspaceId);
    const id = this.store.id("doc");
    const versionId = this.store.id("docver");
    const bytes = decodeBase64(String(payload["bytesBase64"]));
    const mediaType = String(payload["mediaType"]);
    if (!MEDIA_TYPES.has(mediaType)) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "document media type is not supported");
    const fileName = safeFileName(String(payload["fileName"]));
    const title = String(payload["title"]);
    const digest = sha256Digest(bytes);
    const extracted = extract(mediaType, bytes);
    this.storage.put(digest, bytes);
    this.store.inTx(db, () => {
      const now = this.store.now();
      db.prepare("INSERT INTO documents(id,title,state,current_version_id,created_by,created_at_ms,updated_at_ms) VALUES (?,?,'active',?,?,?,?)")
        .run(id, title, versionId, actor.actorId, now, now);
      this.insertVersion(db, versionId, id, 1, digest, bytes, mediaType, fileName, extracted, actor.actorId, now);
      db.prepare("INSERT INTO document_fts(document_id,version_id,title,content) VALUES (?,?,?,?)").run(id, versionId, title, extracted.text ?? "");
      this.store.emit(db, { aggregateType: "document", aggregateId: id, eventType: "document.uploaded", payload: { documentId: id, versionId, digest } });
    });
    return id;
  }

  private revise(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const document = this.row(actor, workspaceId, String(payload["documentId"]));
    if (document.state !== "active") throw new BrainDomainError("CONFLICT", "revoked documents cannot be revised");
    assertExpectedVersion(document.version, expectedVersion);
    const db = this.db(actor, workspaceId);
    const versionId = this.store.id("docver");
    const bytes = decodeBase64(String(payload["bytesBase64"]));
    const mediaType = String(payload["mediaType"]);
    if (!MEDIA_TYPES.has(mediaType)) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "document media type is not supported");
    const fileName = safeFileName(String(payload["fileName"]));
    const digest = sha256Digest(bytes);
    const extracted = extract(mediaType, bytes);
    this.storage.put(digest, bytes);
    this.store.inTx(db, () => {
      const current = db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM document_versions WHERE document_id=?").get(document.id) as { revision: number };
      const now = this.store.now();
      this.insertVersion(db, versionId, document.id, current.revision + 1, digest, bytes, mediaType, fileName, extracted, actor.actorId, now);
      db.prepare("UPDATE documents SET title=?,current_version_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(String(payload["title"]), versionId, now, document.id, document.version);
      db.prepare("DELETE FROM document_fts WHERE document_id=?").run(document.id);
      db.prepare("INSERT INTO document_fts(document_id,version_id,title,content) VALUES (?,?,?,?)").run(document.id, versionId, String(payload["title"]), extracted.text ?? "");
      this.store.emit(db, { aggregateType: "document", aggregateId: document.id, eventType: "document.revised", payload: { documentId: document.id, versionId, digest } });
    });
    return versionId;
  }

  private insertVersion(db: ReturnType<Store["workspaceDb"]>, id: string, documentId: string, revision: number, digest: string, bytes: Uint8Array, mediaType: string, fileName: string, extracted: { status: DocumentVersion["extractionStatus"]; text: string | null }, actorId: string, now: number): void {
    db.prepare(`INSERT INTO document_versions(id,document_id,revision,digest,bytes,media_type,file_name,extraction_status,extracted_text,created_by,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, documentId, revision, digest, bytes.length, mediaType, fileName, extracted.status, extracted.text, actorId, now);
    db.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES (?,?,?,?,'workspace','verified',?)")
      .run(id, digest, bytes.length, mediaType, now);
  }

  private associate(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const document = this.row(actor, workspaceId, String(payload["documentId"]));
    if (document.state !== "active") throw new BrainDomainError("CONFLICT", "revoked documents cannot be associated");
    const resource = payload["resource"] as { kind: ResourceAssociation["resourceKind"]; id: string };
    const table = { workItem: "work_items", objective: "objectives", session: "sessions", run: "workflow_runs" }[resource.kind];
    const db = this.db(actor, workspaceId);
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(resource.id)) throw new BrainDomainError("NOT_FOUND", "association target not found in this workspace");
    const id = this.store.id("assoc");
    this.store.inTx(db, () => {
      db.prepare("INSERT INTO resource_associations(id,document_id,resource_kind,resource_id,created_by,created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(id, document.id, resource.kind, resource.id, actor.actorId, this.store.now());
      this.store.emit(db, { aggregateType: "document", aggregateId: document.id, eventType: "document.associated", payload: { documentId: document.id, associationId: id, resourceKind: resource.kind, resourceId: resource.id } });
    });
    return id;
  }

  private revoke(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const document = this.row(actor, workspaceId, String(payload["documentId"]));
    assertExpectedVersion(document.version, expectedVersion);
    if (document.state === "revoked") return document.id;
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE documents SET state='revoked',version=version+1,updated_at_ms=? WHERE id=? AND version=?").run(this.store.now(), document.id, document.version);
      db.prepare("DELETE FROM document_fts WHERE document_id=?").run(document.id);
      this.store.emit(db, { aggregateType: "document", aggregateId: document.id, eventType: "document.revoked", payload: { documentId: document.id, reason: String(payload["reason"]) } });
    });
    return document.id;
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string, limit = 100, search?: string): JsonValue {
    const db = this.db(actor, workspaceId);
    if (queryType === "documents.list") {
      const rows = db.prepare("SELECT * FROM documents WHERE state='active' ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as DocumentRow[];
      return { items: rows.map((row) => DocumentService.document(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "documents.search") {
      const tokens = (search ?? "").match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
      if (tokens.length === 0) return { items: [] } as unknown as JsonValue;
      const ftsQuery = tokens.map((token) => `${token}*`).join(" AND ");
      const rows = db.prepare("SELECT d.* FROM document_fts f JOIN documents d ON d.id=f.document_id WHERE document_fts MATCH ? AND d.state='active' ORDER BY rank LIMIT ?").all(ftsQuery, limit) as DocumentRow[];
      return { items: rows.map((row) => DocumentService.document(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "documents.get") {
      const document = this.row(actor, workspaceId, String(resourceId));
      const versions = db.prepare("SELECT * FROM document_versions WHERE document_id=? ORDER BY revision DESC LIMIT 100").all(document.id) as VersionRow[];
      const associations = db.prepare("SELECT * FROM resource_associations WHERE document_id=? ORDER BY created_at_ms,id LIMIT 100").all(document.id) as AssociationRow[];
      const current = versions.find((version) => version.id === document.current_version_id);
      if (!current) throw new BrainDomainError("INTERNAL_ERROR", "document current version is missing");
      const bytes = this.storage.read(current.digest);
      const extracted = extract(current.media_type, bytes);
      if (extracted.status !== current.extraction_status || extracted.text !== current.extracted_text) throw new BrainDomainError("CONFLICT", "document extraction does not match immutable bytes");
      const view: DocumentView = {
        document: DocumentService.document(workspaceId, document), versions: versions.map(DocumentService.version), associations: associations.map(DocumentService.association),
        preview: extracted.status === "ready" && extracted.text !== null
          ? { kind: "text", text: extracted.text.slice(0, 64 * 1024), truncated: extracted.text.length > 64 * 1024 }
          : { kind: "download-only" },
      };
      return view as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported document query ${queryType}`);
  }
}
