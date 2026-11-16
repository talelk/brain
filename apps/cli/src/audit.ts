import { readFileSync, writeFileSync } from "node:fs";
import { AUDIT_EXPORT_FORMAT, verifyAuditExport, type AuditCheckpoint, type AuditEventRecord, type AuditExportPage, type AuditKey, type AuditOverview, type AuditVerifyResult } from "@brain/contracts";
import type { OperateContext } from "./operate.ts";

/**
 * `brain audit` (ADR 0078): export the audit logs from the Governor's HTTP API and verify them here, offline, with the same verifier the
 * Governor was built with. Nothing is trusted from the Governor except the bytes: every digest, link and checkpoint signature is recomputed.
 */
const USAGE = `usage:
  brain audit verify [--file <export.json>] [--trust-key <keys.json>] [--json]   verify the logs (fetched from the Governor unless --file is given)
  brain audit export [--out <export.json>] [--workspace <id>]                     write every log, its checkpoints and the public keys
  brain audit keys [--out <keys.json>]                                           the public audit keys (pass the file to verify --trust-key to pin them)
  brain audit checkpoint [--workspace <id>]                                      sign a checkpoint now
  brain audit rotate-key                                                         retire the audit key and make a new one
`;

interface ExportFile { format: typeof AUDIT_EXPORT_FORMAT; organizationId: string; exportedAt: string; keys: AuditKey[]; chains: Array<{ scope: string; events: AuditEventRecord[]; checkpoints: AuditCheckpoint[] }> }

function flags(args: string[]): { positional: string[]; get(name: string): string | undefined; json: boolean } {
  const positional: string[] = []; const map = new Map<string, string>(); let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg.startsWith("--")) { const value = args[i + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`); map.set(arg, value); i++; }
    else positional.push(arg);
  }
  return { positional, get: (name) => map.get(name), json };
}

export async function audit(args: string[], ctx: OperateContext): Promise<number> {
  let parsed: ReturnType<typeof flags>;
  try { parsed = flags(args); } catch (e) { ctx.stderr(`${(e as Error).message}\n${USAGE}`); return 2; }
  const [verb] = parsed.positional;
  const fail = (result: { status: number; json: unknown }): number => {
    const message = result.json as { message?: string; error?: { message?: string } } | null;
    ctx.stderr(`${message?.message ?? message?.error?.message ?? `request failed (${result.status})`}\n`);
    return 1;
  };

  /** Every log of the organization (or one workspace's, with the control log), page by page. */
  async function fetchExport(only?: string): Promise<ExportFile | number> {
    const overview = await ctx.call("/v1/audit");
    if (overview.status >= 400) return fail(overview);
    const view = overview.json as AuditOverview;
    const scopes = view.scopes.filter((s) => !only || s.workspaceId === null || s.workspaceId === only).map((s) => s.scope);
    if (only && !scopes.includes(`workspace:${only}`)) { ctx.stderr(`no audit log for workspace ${only}\n`); return 1; }
    const chains: ExportFile["chains"] = []; let keys: AuditKey[] = [...view.keys];
    for (const scope of scopes) {
      const events: AuditEventRecord[] = []; let after = 0; let checkpoints: AuditCheckpoint[] = [];
      for (;;) {
        const page = await ctx.call(`/v1/audit/export?scope=${encodeURIComponent(scope)}&afterCursor=${after}&limit=2000`);
        if (page.status >= 400) return fail(page);
        const body = page.json as AuditExportPage;
        events.push(...body.events); checkpoints = [...body.checkpoints]; keys = [...body.keys];
        if (body.nextAfterCursor === null) break;
        after = body.nextAfterCursor;
      }
      chains.push({ scope, events, checkpoints });
    }
    return { format: AUDIT_EXPORT_FORMAT, organizationId: view.organizationId, exportedAt: new Date().toISOString(), keys, chains };
  }

  try {
    if (verb === "verify") {
      let file: ExportFile;
      const given = parsed.get("--file");
      if (given) {
        file = JSON.parse(readFileSync(given, "utf8")) as ExportFile;
        if (file.format !== AUDIT_EXPORT_FORMAT) { ctx.stderr(`${given} is not a Brain audit export\n`); return 2; }
      } else {
        const fetched = await fetchExport(parsed.get("--workspace"));
        if (typeof fetched === "number") return fetched;
        file = fetched;
      }
      const pinFile = parsed.get("--trust-key");
      const pinned = pinFile ? ((JSON.parse(readFileSync(pinFile, "utf8")) as { keys?: AuditKey[] }).keys ?? []) : undefined;
      const result = verifyAuditExport(file, pinned ? { trustedKeys: pinned } : {});
      report(result, ctx, parsed.json, file.chains.reduce((n, c) => n + c.events.length, 0));
      return result.ok ? 0 : 1;
    }
    if (verb === "export") {
      const fetched = await fetchExport(parsed.get("--workspace"));
      if (typeof fetched === "number") return fetched;
      const text = `${JSON.stringify(fetched)}\n`;
      const out = parsed.get("--out");
      if (out) { writeFileSync(out, text, { mode: 0o600 }); ctx.stdout(parsed.json ? `${JSON.stringify({ written: out, logs: fetched.chains.length })}\n` : `Wrote ${fetched.chains.length} audit logs to ${out}\n`); }
      else ctx.stdout(text);
      return 0;
    }
    if (verb === "keys") {
      const overview = await ctx.call("/v1/audit");
      if (overview.status >= 400) return fail(overview);
      const view = overview.json as AuditOverview;
      const text = `${JSON.stringify({ format: "brain.audit-keys/v1", activeKeyId: view.activeKeyId, keys: view.keys })}\n`;
      const out = parsed.get("--out");
      if (out) { writeFileSync(out, text); ctx.stdout(`Wrote ${view.keys.length} public audit keys to ${out}\n`); } else ctx.stdout(text);
      return 0;
    }
    if (verb === "checkpoint") {
      const workspace = parsed.get("--workspace");
      const result = await ctx.call("/v1/audit/checkpoints", workspace ? { workspaceId: workspace } : {});
      if (result.status >= 400) return fail(result);
      const made = (result.json as { checkpoints: AuditCheckpoint[] }).checkpoints;
      ctx.stdout(parsed.json ? `${JSON.stringify(result.json)}\n` : `Signed ${made.length} checkpoint${made.length === 1 ? "" : "s"}\n`);
      return 0;
    }
    if (verb === "rotate-key") {
      const result = await ctx.call("/v1/audit/keys/rotate", {});
      if (result.status >= 400) return fail(result);
      const body = result.json as { activeKeyId: string; retiredKeyId: string };
      ctx.stdout(parsed.json ? `${JSON.stringify(result.json)}\n` : `Retired ${body.retiredKeyId}; the audit key is now ${body.activeKeyId}\n`);
      return 0;
    }
  } catch (e) {
    ctx.stderr(`${e instanceof Error ? e.message : "audit command failed"}\n`);
    return 1;
  }
  ctx.stderr(USAGE);
  return 2;
}

function report(result: AuditVerifyResult, ctx: OperateContext, json: boolean, total: number): void {
  if (json) { ctx.stdout(`${JSON.stringify(result)}\n`); return; }
  const trust = result.keysPinned ? "keys pinned by you" : "keys taken from the export, not pinned";
  if (result.ok && result.assurance === "chain-only") {
    ctx.stdout(`OK (hash chain only): ${result.verifiedEvents} events in ${result.chains.length} ${result.chains.length === 1 ? "log" : "logs"} link to each other and match their digests. No signed checkpoint was checked, so a chain rebuilt from the start or a cut tail would NOT be detected. Run brain audit checkpoint, then verify again, and pin the keys.\n`);
    for (const warning of result.warnings) ctx.stdout(`warning: ${warning}\n`);
    return;
  }
  if (result.ok) {
    ctx.stdout(`OK: ${result.verifiedEvents} events in ${result.chains.length} ${result.chains.length === 1 ? "log" : "logs"} verified; ${result.checkpointsVerified} signed checkpoint${result.checkpointsVerified === 1 ? "" : "s"} hold (${trust}).\n`);
    for (const warning of result.warnings) ctx.stdout(`warning: ${warning}\n`);
    ctx.stdout("Events written after the last checkpoint of a log are protected by the chain only; take checkpoints often and keep exports off the host.\n");
    return;
  }
  const b = result.break!;
  ctx.stderr(`BROKEN: ${b.kind} in log ${b.chain}${b.chainSeq !== null ? ` at event ${b.chainSeq}` : ""}${b.eventId ? ` (${b.eventId})` : ""}\n${b.detail}\n${result.verifiedEvents} of ${total} events were verified before the break.\n`);
}
