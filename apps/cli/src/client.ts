import { randomUUID } from "node:crypto";
import { collectRelease } from "./release.ts";
import { credentialStore, readSetupCredential, validCredential } from "./credentials.ts";
import { prompt } from "./prompt.ts";

export interface CliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly prompt?: (label: string, secret?: boolean) => Promise<string>;
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const ask = options.prompt ?? prompt;
  const transport = options.fetch ?? ((request: Request) => fetch(request));
  let base: URL;
  try {
    base = new URL(env["BRAIN_GOVERNOR_URL"] ?? "http://127.0.0.1:3000");
    if (base.username || base.password || base.pathname !== "/" || base.search || base.hash || !["http:","https:"].includes(base.protocol)) throw new Error();
    if (base.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error();
  } catch { stderr("Governor URL must be a credential-free origin; remote access requires HTTPS.\n"); return 1; }
  const credentials = credentialStore(base.origin, env);
  const flag = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index+1]; };
  async function call(path: string, body?: unknown, token = env["BRAIN_TOKEN"] ?? credentials.read(), headers: Record<string,string> = {}) {
    if (token && !validCredential(token)) throw new Error("invalid credential format");
    const response = await transport(new Request(`${base.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: base.origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    }));
    const text = await response.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) as unknown : null; }
    catch { throw new Error("Governor did not return a JSON response"); }
    return { status: response.status, json, response };
  }
  const [cmd, ...rest] = argv;
  const jsonOut = argv.includes("--json");
  const print = (v: unknown, status: number) => {
    if (jsonOut) stdout(`${JSON.stringify(v)}\n`);
    else stdout(`${JSON.stringify(v, null, 2)}\n`);
    return status >= 400 ? 1 : 0;
  };
  try {
    switch (cmd) {
      case "doctor": {
        const identity = await call("/v1/identity");
        if (identity.status >= 400) return print(identity.json, identity.status);
        const workspaceId = flag("--workspace") ?? (identity.json as { workspaces: { workspaceId: string }[] }).workspaces[0]?.workspaceId;
        if (!workspaceId) throw new Error("Create a workspace before running brain doctor");
        const r = await call(`/v1/doctor?workspaceId=${encodeURIComponent(workspaceId)}`);
        const result = print(r.json, r.status);
        return result || ((r.json as { ready?: boolean }).ready ? 0 : 1);
      }
      case "query": {
        const query = JSON.parse(rest.filter((a) => a !== "--json").join(" ") || "{}") as unknown;
        const r = await call("/v1/query", query);
        return print(r.json, r.status);
      }
      case "command": {
        const command = JSON.parse(rest.filter((a) => a !== "--json").join(" ") || "{}") as { commandType?: string };
        if (command.commandType === "approval.decision") {
          stderr("Approval decisions require interactive human review in the web UI.\n");
          return 2;
        }
        const r = await call("/v1/commands", command);
        return print(r.json, r.status);
      }
      case "login": case "setup": {
        const email = flag("--email") ?? env["BRAIN_EMAIL"] ?? await ask("Email");
        const password = env["BRAIN_PASSWORD"] ?? await ask("Password", true);
        let result;
        if (cmd === "setup") {
          if (!argv.includes("--local")) { stderr("usage: brain setup --local --email <email> --name <name> --org <id> [--setup-token-file <private-file>]\n"); return 2; }
          const file = flag("--setup-token-file");
          const setupToken = file ? readSetupCredential(file) : env["BRAIN_SETUP_TOKEN"];
          if (!setupToken || !/^[A-Za-z0-9_-]{43}$/u.test(setupToken)) throw new Error("local setup requires BRAIN_SETUP_TOKEN or --setup-token-file");
          result = await call("/v1/setup", { email, password, name: flag("--name") ?? "My organization", organizationId: flag("--org") ?? "org-local" }, "", { authorization: `Setup ${setupToken}` });
        } else {
          result = await call("/api/auth/sign-in/email", { email, password }, "");
          if ((result.json as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
            const code = env["BRAIN_TOTP"] ?? await ask("Authenticator code", true);
            const cookie = result.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            result = await call("/api/auth/two-factor/verify-totp", { code, trustDevice: false }, "", { cookie, origin: base.origin });
          }
        }
        if (result.status >= 400) return print(result.json, result.status);
        const token = result.response.headers.get("set-auth-token") ?? (result.json as { token?: string; sessionToken?: string }).token ?? (result.json as { sessionToken?: string }).sessionToken;
        if (!token) throw new Error("sign-in did not issue a session credential");
        const current = await call("/v1/identity", undefined, token);
        if (current.status >= 400) return print(current.json, current.status);
        credentials.save(token);
        return print({ authenticated: true, organizationId: (current.json as { actor: { organizationId: string } }).actor.organizationId }, 200);
      }
      case "logout": {
        const result = await call("/api/auth/sign-out", {});
        if (result.status >= 400) return print(result.json, result.status);
        credentials.clear(); return print({ signedOut: true }, 200);
      }
      case "runner": {
        if (rest[0] === "token" && rest[1] === "create") {
          const group = rest[rest.indexOf("--group") + 1] ?? "fixture-tools";
          const r = await call("/v1/runner-tokens", { groupId: group });
          return print(r.json, r.status);
        }
        stderr("usage: brain runner token create --group <id>\n");
        return 2;
      }
      case "workspace": {
        if (rest[0] === "create" && rest[1]) {
          const r = await call("/v1/setup/workspace", { workspaceId: rest[1], slug: flag("--slug") ?? rest[1] });
          return print(r.json, r.status);
        }
        stderr("usage: brain workspace create <id> [--slug <slug>]\n"); return 2;
      }
      case "config": {
        if (rest[0] === "compile" && rest[1]) {
          const bundle = collectRelease(rest[1]);
          const r = await call("/v1/setup/config", { ...bundle, sourceRevision: flag("--source-revision") ?? bundle.sourceRevision });
          return print(r.json, r.status);
        }
        if (rest[0] === "inspect" && rest[1]) {
          const r = await call(`/v1/config/releases/${encodeURIComponent(rest[1])}`);
          return print(r.json, r.status);
        }
        if (rest[0] === "activate" && rest[1]) {
          const inspected = await call(`/v1/config/releases/${encodeURIComponent(rest[1])}`);
          if (inspected.status >= 400) return print(inspected.json, inspected.status);
          const expectedActiveDigest = (inspected.json as { expectedActiveDigest: string | null }).expectedActiveDigest;
          const r = await call("/v1/commands", {
            contractVersion: "brain.command/v1", commandType: "config.activate",
            commandId: randomUUID(), idempotencyKey: randomUUID(),
            payload: { configDigest: rest[1], expectedActiveDigest },
          });
          return print(r.json, r.status);
        }
        stderr("usage: brain config <compile <dir> [--source-revision <digest>]|inspect <digest>|activate <digest>>\n");
        return 2;
      }
      case "workflow": {
        const workspaceId = flag("--workspace");
        if (!workspaceId) throw new Error("workflow commands require --workspace <id>");
        if (rest[0] === "list") {
          const r = await call("/v1/query", { queryType: "workflows.list", workspaceId });
          return print(r.json, r.status);
        }
        if (rest[0] === "run" && rest[1]) {
          const input = JSON.parse(flag("--input") ?? "{}");
          const catalog = await call("/v1/query", { queryType: "workflows.get", workspaceId, resourceId: rest[1] });
          if (catalog.status >= 400) return print(catalog.json, catalog.status);
          const workflow = (catalog.json as { snapshot: { release: { id: string; digest: string } } }).snapshot.release;
          const r = await call("/v1/commands", {
            contractVersion: "brain.command/v1", commandType: "workflow.dispatch",
            commandId: randomUUID(), idempotencyKey: randomUUID(), workspaceId,
            payload: { workflow, input },
          });
          return print(r.json, r.status);
        }
        stderr("usage: brain workflow <list|run <id> --input <json>> --workspace <id>\n");
        return 2;
      }
      case "backup": {
        stderr("Run trusted offline maintenance on the Governor host: pnpm --filter @brain/governor maintenance <backup|verify|restore> (see docs/implementation/10-performance-and-operations.md).\n");
        return 2;
      }
      default:
        stderr("usage: brain <login|logout|doctor|query|command|setup|runner|config|workflow|workspace|backup> [--json]\n");
        return cmd ? 2 : 0;
    }
  } catch (e) {
    stderr(`${e instanceof Error ? e.message : "cli error"}\n`);
    return 1;
  }
}
