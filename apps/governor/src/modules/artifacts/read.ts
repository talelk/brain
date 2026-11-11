import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { readVerified } from "./cas";

/**
 * The text of one verified artifact of a workspace, for a governed read tool. The artifact must be a row of that workspace (an id from
 * another workspace is NOT_FOUND), must be text-like and must fit the bound; the bytes are re-verified against their digest.
 */
export function readWorkspaceArtifactText(store: Store, organizationId: string, workspaceId: string, artifactId: string, options: { maxBytes: number; mediaTypes: readonly string[] }): { artifactId: string; digest: string; mediaType: string; text: string } {
  const row = store.workspaceDb(workspaceId, organizationId).prepare("SELECT digest, bytes, media_type FROM artifacts WHERE id=? AND state='verified'").get(artifactId) as { digest: string; bytes: number; media_type: string } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "artifact not found in this workspace");
  const mediaType = row.media_type.split(";")[0]!.trim().toLowerCase();
  if (!options.mediaTypes.includes(mediaType)) throw new BrainDomainError("INVALID_ARGUMENT", `artifact media type ${mediaType} is not readable by this tool`);
  if (row.bytes > options.maxBytes) throw new BrainDomainError("PAYLOAD_TOO_LARGE", `artifact is ${row.bytes} bytes; this tool reads at most ${options.maxBytes}`);
  return { artifactId, digest: row.digest, mediaType, text: new TextDecoder().decode(readVerified(store, row.digest, row.bytes)) };
}
