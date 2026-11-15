import { randomUUID } from "node:crypto";

/** What the operating commands need from the CLI: the HTTP API and the terminal, never Governor internals. */
export interface OperateContext {
  readonly env: NodeJS.ProcessEnv;
  readonly call: (path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly ask: (label: string, secret?: boolean) => Promise<string>;
}

interface Parsed { readonly positional: string[]; readonly flags: Map<string, string[]>; readonly json: boolean }
const BOOLEAN_FLAGS = new Set(["--json", "--auto-start"]);

function parse(args: string[]): Parsed {
  const positional: string[] = []; const flags = new Map<string, string[]>(); let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") { json = true; continue; }
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg)) { flags.set(arg, ["true"]); continue; }
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Usage(`${arg} needs a value`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]); i++;
    } else positional.push(arg);
  }
  return { positional, flags, json };
}

class Usage extends Error {}

/** Aligned plain-text table: a header row, then one line per row. */
export function table(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const width = columns.map((name, i) => Math.max(name.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: readonly string[]) => cells.map((cell, i) => i === cells.length - 1 ? cell : cell.padEnd(width[i]!)).join("  ").trimEnd();
  return [line(columns), ...rows.map(line)].join("\n") + "\n";
}

const USAGE = `usage:
  brain mission list|show <id>|create|pause <id>|resume <id>|owner transfer <id> --to <principal>|verdict <id> --outcome verified|rejected
  brain play list
  brain session list|show <id>|steer <id> --message <text>|stop <id> [--reason <text>]|pause <id>|continue <id>
  brain approval list|show <id>|decide <id> --decision approve|reject|request-changes [--note <text>] [--code <6 digits>]
  common: [--workspace <id>] [--json]
`;

interface Row { [key: string]: unknown }
const text = (value: unknown): string => value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
const short = (value: unknown, max = 60): string => { const s = text(value).replace(/\s+/gu, " "); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export async function operate(group: "mission" | "play" | "session" | "approval", args: string[], ctx: OperateContext): Promise<number> {
  let parsed: Parsed;
  try { parsed = parse(args); } catch (e) { ctx.stderr(`${(e as Error).message}\n${USAGE}`); return 2; }
  const { positional, flags, json } = parsed;
  const flag = (name: string) => flags.get(name)?.at(-1);
  const out = (value: unknown, human: () => string): void => { ctx.stdout(json ? `${JSON.stringify(value)}\n` : human()); };
  const fail = (result: { status: number; json: unknown }): number => {
    const message = (result.json as { message?: string; error?: { message?: string } } | null);
    if (json) ctx.stdout(`${JSON.stringify(result.json)}\n`); else ctx.stderr(`${message?.message ?? message?.error?.message ?? `request failed (${result.status})`}\n`);
    return 1;
  };
  const usage = (): number => { ctx.stderr(USAGE); return 2; };

  async function workspaceId(): Promise<string> {
    const given = flag("--workspace") ?? ctx.env["BRAIN_WORKSPACE"];
    if (given) return given;
    const identity = await ctx.call("/v1/identity");
    if (identity.status >= 400) throw new Usage("could not read your identity; run brain login");
    const spaces = (identity.json as { workspaces: { workspaceId: string; name: string }[] }).workspaces;
    if (spaces.length === 1) return spaces[0]!.workspaceId;
    throw new Usage(spaces.length === 0 ? "you belong to no workspace" : `pass --workspace <id>; yours: ${spaces.map((s) => s.workspaceId).join(", ")}`);
  }
  async function query(type: string, ws: string, extra: Record<string, unknown> = {}) {
    return ctx.call("/v1/query", { queryType: type, workspaceId: ws, ...extra });
  }
  async function command(type: string, ws: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<number> {
    const result = await ctx.call("/v1/commands", {
      contractVersion: "brain.command/v1", commandType: type, commandId: randomUUID(),
      idempotencyKey: flag("--idempotency-key") ?? randomUUID(), workspaceId: ws, payload,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    if (result.status >= 400 || (result.json as { accepted?: boolean }).accepted === false) return fail(result);
    const receipt = result.json as { outcome: string; resourceId?: string };
    out(receipt, () => `${type}: ${receipt.outcome}${receipt.resourceId ? ` (${receipt.resourceId})` : ""}\n`);
    return 0;
  }
  const items = (result: { json: unknown }): Row[] => ((result.json as { snapshot: { items: Row[] } }).snapshot.items);
  const states = (): { states: string[] } | Record<string, never> => flag("--state") ? { states: flag("--state")!.split(",") } : {};
  const limit = (): { limit: number } | Record<string, never> => flag("--limit") ? { limit: Number(flag("--limit")) } : {};

  try {
    const [verb, id] = positional;
    switch (group) {
      case "play": {
        if (verb !== "list") return usage();
        const result = await query("plays.list", await workspaceId());
        if (result.status >= 400) return fail(result);
        const rows = items(result);
        out(result.json, () => table(["PLAY", "TITLE", "TASKS", "AUTONOMY"], rows.map((r) => [text(r["playId"]), short(r["title"], 50), text(r["taskCount"]), text(r["autonomy"])])));
        return 0;
      }
      case "mission": {
        if (verb === "list") {
          const result = await query("missions.list", await workspaceId(), { ...states(), ...limit() });
          if (result.status >= 400) return fail(result);
          out(result.json, () => table(["MISSION", "STATE", "TITLE"], items(result).map((r) => [text(r["missionId"] ?? r["id"]), text(r["state"]), short(r["title"], 60)])));
          return 0;
        }
        if (verb === "show" && id) {
          const result = await query("missions.get", await workspaceId(), { resourceId: id });
          if (result.status >= 400) return fail(result);
          out(result.json, () => {
            const m = (result.json as { snapshot: Row }).snapshot;
            const criteria = (m["successCriteria"] as Row[] | undefined) ?? [];
            return [`${text(m["title"])}  [${text(m["state"])}]`, `id: ${text(m["missionId"])}  version: ${text(m["version"])}  owner: ${text(m["ownerId"])}`, `intent: ${short(m["intent"], 300)}`,
              ...(criteria.length ? ["success criteria:", ...criteria.map((c) => `  - ${text(c["text"] ?? c["criterion"] ?? c["id"])}${c["met"] === true ? " (met)" : ""}`)] : [])].join("\n") + "\n";
          });
          return 0;
        }
        if (verb === "create") {
          const play = flag("--play"); const title = flag("--title");
          if (!title) { ctx.stderr("mission create needs --title <text> (add --play <id> to start from a Play)\n"); return 2; }
          const criteria = flags.get("--criterion") ?? [];
          if (!play && (!flag("--intent") || criteria.length === 0)) { ctx.stderr("without --play, mission create needs --intent <text> and at least one --criterion <text>\n"); return 2; }
          return await command("mission.create", await workspaceId(), {
            title, ...(flag("--intent") ? { intent: flag("--intent") } : {}), ...(criteria.length ? { successCriteria: criteria } : {}),
            ...(play ? { playId: play } : {}), ...(flag("--autonomy") ? { autonomy: flag("--autonomy") } : {}), ...(flags.has("--auto-start") ? { autoStart: true } : {}),
          });
        }
        if ((verb === "pause" || verb === "resume") && id) return await command(`mission.${verb}`, await workspaceId(), { missionId: id });
        if (verb === "owner" && id === "transfer" && positional[2]) {
          const to = flag("--to"); if (!to) { ctx.stderr("owner transfer needs --to <principal id>\n"); return 2; }
          return await command("mission.owner.transfer", await workspaceId(), { missionId: positional[2], newOwnerId: to });
        }
        if (verb === "verdict" && id) {
          const outcome = flag("--outcome");
          if (outcome !== "verified" && outcome !== "rejected") { ctx.stderr("verdict needs --outcome verified|rejected\n"); return 2; }
          const ws = await workspaceId();
          let bundleDigest = flag("--bundle");
          if (!bundleDigest) {
            const latest = await query("missionBundles.latest", ws, { resourceId: id });
            if (latest.status >= 400) return fail(latest);
            bundleDigest = (latest.json as { snapshot: { bundleDigest?: string; digest?: string } | null }).snapshot?.bundleDigest ?? (latest.json as { snapshot: { digest?: string } | null }).snapshot?.digest;
            if (!bundleDigest) { ctx.stderr("this mission has no evidence bundle to sign off yet; pass --bundle <digest> to name one\n"); return 1; }
          }
          return await command("mission.verdict.record", ws, { missionId: id, bundleDigest, outcome, ...(flags.has("--finding") ? { findings: flags.get("--finding") } : {}) });
        }
        return usage();
      }
      case "session": {
        if (verb === "list") {
          const result = await query("sessions.list", await workspaceId(), { ...states(), ...limit() });
          if (result.status >= 400) return fail(result);
          out(result.json, () => table(["SESSION", "STATE", "AGENT", "TASK"], items(result).map((r) => [text(r["sessionId"]), text(r["state"]) + (r["pause"] && (r["pause"] as Row)["state"] !== "running" ? `/${text((r["pause"] as Row)["state"])}` : ""), text(r["agentId"]), short(r["task"], 50)])));
          return 0;
        }
        if (verb === "show" && id) {
          const result = await query("session.get", await workspaceId(), { resourceId: id });
          if (result.status >= 400) return fail(result);
          out(result.json, () => {
            const s = (result.json as { snapshot: Row }).snapshot;
            return [`${short(s["task"], 200)}  [${text(s["state"])}]`, `id: ${text(s["sessionId"])}  agent: ${text(s["agentId"])}  mode: ${text(s["mode"])}  version: ${text(s["version"])}`,
              `tokens: ${text(s["usedTokens"])}  spent: ${text(s["usedMicroUsd"])} micro-USD  updated: ${text(s["updatedAt"])}`].join("\n") + "\n";
          });
          return 0;
        }
        if (verb === "steer" && id) {
          const message = flag("--message"); if (!message) { ctx.stderr("steer needs --message <text>\n"); return 2; }
          return await command("session.steer", await workspaceId(), { sessionId: id, message });
        }
        if (verb === "stop" && id) return await command("session.stop", await workspaceId(), { sessionId: id, reason: flag("--reason") ?? "stopped from the CLI" });
        if ((verb === "pause" || verb === "continue") && id) return await command(`session.${verb}`, await workspaceId(), { sessionId: id });
        return usage();
      }
      case "approval": {
        if (verb === "list") {
          const result = await query("approvals.list", await workspaceId(), { ...(flag("--state") ? states() : { states: ["pending"] }), ...limit() });
          if (result.status >= 400) return fail(result);
          out(result.json, () => table(["APPROVAL", "STATE", "OPERATION", "CREATED"], items(result).map((r) => [text(r["approvalId"]), text(r["state"]), text(((r["subject"] as Row | undefined) ?? {})["operation"]), text(r["createdAt"])])));
          return 0;
        }
        if (verb === "show" && id) {
          const result = await query("approval.get", await workspaceId(), { resourceId: id });
          if (result.status >= 400) return fail(result);
          out(result.json, () => {
            const a = (result.json as { snapshot: Row }).snapshot; const s = (a["subject"] as Row | undefined) ?? {};
            return [`${text(s["operation"])}  [${text(a["state"])}]`, `id: ${text(a["approvalId"])}  version: ${text(a["version"])}  requested by: ${text(a["requestedBy"])}`, `subject digest: ${text(a["subjectDigest"])}`, `created: ${text(a["createdAt"])}`].join("\n") + "\n";
          });
          return 0;
        }
        if (verb === "decide" && id) return await decide(id);
        return usage();
      }
    }
  } catch (e) {
    if (e instanceof Usage) { ctx.stderr(`${e.message}\n`); return 2; }
    throw e;
  }

  /** The same evidence flow as the app: a challenge bound to this approval's exact subject, verified fresh, spent by this one decision. */
  async function decide(approvalId: string): Promise<number> {
    const decision = flag("--decision");
    if (decision !== "approve" && decision !== "reject" && decision !== "request-changes") { ctx.stderr("decide needs --decision approve|reject|request-changes\n"); return 2; }
    const ws = await workspaceId();
    const got = await query("approval.get", ws, { resourceId: approvalId });
    if (got.status >= 400) return fail(got);
    const approval = (got.json as { snapshot: { subjectDigest: string; version: number; state: string } }).snapshot;
    if (approval.state !== "pending") { ctx.stderr(`approval is ${approval.state}, not pending\n`); return 1; }
    const challenge = await ctx.call("/v1/step-up/challenges", { approvalId, subjectDigest: approval.subjectDigest });
    if (challenge.status >= 400) return fail(challenge);
    const { challengeId, method } = challenge.json as { challengeId: string; method: "session" | "totp" };
    let code = flag("--code") ?? ctx.env["BRAIN_TOTP"] ?? "";
    if (method === "totp" && !code) {
      if (json) { ctx.stderr("this approval needs your authenticator code: pass --code <6 digits> or set BRAIN_TOTP\n"); return 2; }
      code = await ctx.ask("Authenticator code", true);
    }
    if (method === "session") code = flag("--code") ?? "";
    const verified = await ctx.call("/v1/step-up/verify", { challengeId, ...(code ? { code } : {}) });
    if (verified.status >= 400) return fail(verified);
    const { evidenceId } = verified.json as { evidenceId: string };
    const decided = await ctx.call(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: flag("--idempotency-key") ?? randomUUID(), decision,
      subjectDigest: approval.subjectDigest, expectedVersion: approval.version, note: flag("--note") ?? "", stepUpEvidenceId: evidenceId,
    });
    if (decided.status >= 400) return fail(decided);
    const result = decided.json as { state: string };
    out(decided.json, () => `approval ${approvalId}: ${result.state}\n`);
    return 0;
  }
  return usage();
}
