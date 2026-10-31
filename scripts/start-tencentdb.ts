import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const revision = process.env["BRAIN_TENCENTDB_REVISION"] ?? "ecc01a545da0b2ac6cae2f0f0af0d39d41469793";
const checkout = resolve(
  process.env["BRAIN_TENCENTDB_CHECKOUT"] ?? join(process.env["BRAIN_INSTANCE_DIR"] ?? join(homedir(), ".local", "share", "brain"), "tencentdb-agent-memory"),
);
const deployment = join(checkout, "deploy", "global-images");
const runDir = resolve(process.env["BRAIN_RUN_DIR"] ?? join(process.env["BRAIN_INSTANCE_DIR"] ?? join(homedir(), ".local", "share", "brain"), "run"));
const coreUrl = (process.env["BRAIN_TENCENTDB_URL"] ?? "http://127.0.0.1:8420").replace(/\/$/u, "");
const panelUrl = (process.env["BRAIN_MEMORY_UI_URL"] ?? "http://127.0.0.1:8125").replace(/\/$/u, "");
const proxyUrl = (process.env["BRAIN_ANTHROPIC_BASE_URL"] ?? "http://127.0.0.1:8096/claude-code/default").replace(/\/$/u, "");
const bindingFile = join(runDir, "tencentdb-binding.json");
const credentialFile = join(runDir, "tencentdb-claude-user-key");

function privateWrite(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function privateRead(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(`${file} must be an owned private regular file`);
  return readFileSync(file, "utf8").trim();
}

async function run(command: string, args: string[], redact = false): Promise<void> {
  const child = spawn(command, args, { cwd: existsSync(deployment) ? deployment : process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const forward = (bytes: Buffer) => {
    const text = bytes.toString();
    process.stderr.write(
      redact ? text.replace(/ANTHROPIC_AUTH_TOKEN=.*/gu, "ANTHROPIC_AUTH_TOKEN=[redacted]").replace(/sk-mem-[A-Za-z0-9_-]+/gu, "[redacted]") : text,
    );
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", resolveCode);
  });
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`);
}

async function reachable(url: string, requireSuccess = true): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return requireSuccess ? response.ok : true;
  } catch {
    return false;
  }
}

interface Binding {
  teamId: string;
  agentId: string;
  userId: string;
}
function savedBinding(): Binding | null {
  if (!existsSync(bindingFile)) return null;
  const value = JSON.parse(privateRead(bindingFile)) as Partial<Binding>;
  return typeof value.teamId === "string" && typeof value.agentId === "string" && typeof value.userId === "string" ? (value as Binding) : null;
}

async function main(): Promise<void> {
  if (process.argv.includes("--stop")) {
    if (existsSync(join(deployment, "stop-all.sh"))) await run("bash", [join(deployment, "stop-all.sh")]);
    return;
  }
  if (!existsSync(join(checkout, ".git"))) {
    if (existsSync(checkout)) throw new Error(`TencentDB checkout is not a Git worktree: ${checkout}`);
    mkdirSync(dirname(checkout), { recursive: true, mode: 0o700 });
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/TencentCloud/TencentDB-Agent-Memory.git", checkout]);
  }
  await run("git", ["-C", checkout, "sparse-checkout", "set", "deploy/global-images", "MemoryCore/pi-plugin"]);
  const actual = await new Promise<string>((resolveRevision, reject) => {
    const child = spawn("git", ["-C", checkout, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "",
      errors = "";
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes: Buffer) => {
      errors += bytes;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRevision(output.trim());
      else reject(new Error(errors || "Could not inspect TencentDB revision"));
    });
  });
  if (actual !== revision) {
    await run("git", ["-C", checkout, "checkout", "--detach", revision]);
  }

  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const envFile = join(deployment, ".env");
  if (!existsSync(envFile)) privateWrite(envFile, readFileSync(join(deployment, ".env.example"), "utf8"));
  chmodSync(envFile, 0o600);
  const settings: Record<string, string> = {
    MEMORY_LLM_BASE_URL: process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1",
    MEMORY_LLM_API_KEY: process.env["BRAIN_LOCAL_MODEL_API_KEY"] || "local-no-key",
    MEMORY_LLM_MODEL: process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b",
    MEMORY_LLM_PROTOCOL: "openai",
    PROXY_UPSTREAM_URL: process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1",
    PROXY_UPSTREAM_API_KEY: process.env["BRAIN_LOCAL_MODEL_API_KEY"] || "local-no-key",
    PROXY_UPSTREAM_MODEL: process.env["BRAIN_CLAUDE_MODEL"] ?? process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b",
    PROXY_FULL_STACK: "1",
  };
  let envText = privateRead(envFile);
  for (const [key, value] of Object.entries(settings)) {
    const current = envText.match(new RegExp(`^${key}=(.*)$`, "mu"))?.[1]?.trim();
    if (!current || current.startsWith("REPLACE_ME") || key === "PROXY_FULL_STACK") {
      const line = `${key}=${value}`;
      envText = new RegExp(`^${key}=.*$`, "mu").test(envText) ? envText.replace(new RegExp(`^${key}=.*$`, "mu"), line) : `${envText.trimEnd()}\n${line}\n`;
    }
  }
  privateWrite(envFile, envText);

  const healthy = (await reachable(`${coreUrl}/health`)) && (await reachable(panelUrl)) && (await reachable(`${proxyUrl}/v1/models`, false));
  if (!healthy) await run("bash", [join(deployment, "start-all.sh")], true);
  if (!(await reachable(`${coreUrl}/health`))) throw new Error(`TencentDB Memory Core is not healthy at ${coreUrl}`);
  if (!(await reachable(panelUrl))) throw new Error(`TencentDB Panel UI is not reachable at ${panelUrl}`);
  if (!(await reachable(`${proxyUrl}/v1/models`, false))) throw new Error(`TencentDB proxy is not reachable at ${proxyUrl}`);

  const adminKey = privateRead(join(deployment, ".admin-key"));
  async function api<T>(path: string, body: Record<string, unknown>, userKey = adminKey): Promise<T> {
    const response = await fetch(`${coreUrl}/v3/meta${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": "default", "x-tdai-user-key": userKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const envelope = (await response.json()) as { code?: number; message?: string; data?: T };
    if (!response.ok || envelope.code !== 0 || !envelope.data) throw new Error(`TencentDB ${path} failed: ${envelope.message ?? response.status}`);
    return envelope.data;
  }
  const users = await api<{ items: { user_id: string }[] }>("/user/list", { username: "brain_local_evaluator", limit: 100 });
  const userId =
    users.items[0]?.user_id ??
    (await api<{ user_id: string }>("/user/create", { username: "brain_local_evaluator", user_id: "brain_local_evaluator" })).user_id;
  let credentialValid = false;
  if (existsSync(credentialFile)) {
    const key = privateRead(credentialFile);
    const verification = await api<{ valid: boolean }>("/auth/verify", { user_key: key }, key);
    credentialValid = verification.valid;
  }
  if (!credentialValid) {
    const created = await api<{ key_value: string }>("/user-key/create", { user_id: userId, name: "brain-local-claude" });
    privateWrite(credentialFile, `${created.key_value}\n`);
  }
  const credential = privateRead(credentialFile);
  let binding = savedBinding();
  if (!binding || binding.userId !== userId) {
    const teams = await api<{ items: { team_id: string; name: string }[] }>("/team/list", { user_id: userId, limit: 100 });
    const teamId =
      teams.items.find((team) => team.name === "Brain Local")?.team_id ??
      (await api<{ team_id: string }>("/team/create", { name: "Brain Local", owner_user_id: userId, description: "Brain local runner memory" }, credential))
        .team_id;
    const agents = await api<{ items: { agent_id: string; name: string }[] }>("/agent/list", { team_id: teamId, limit: 100 });
    const agentId =
      agents.items.find((agent) => agent.name === "Brain Evaluator")?.agent_id ??
      (
        await api<{ agent_id: string }>(
          "/agent/create",
          {
            team_id: teamId,
            owner_user_id: userId,
            name: "Brain Evaluator",
            description: "Independent Brain workflow evaluation",
            prompt: "Evaluate Brain outputs using only the pinned evaluator and immutable evidence.",
            visibility: "team",
          },
          credential,
        )
      ).agent_id;
    binding = { teamId, agentId, userId };
  }
  privateWrite(bindingFile, `${JSON.stringify(binding)}\n`);
  process.stdout.write(`${binding.teamId} ${binding.agentId}\n`);
}

main().catch((error) => {
  console.error(`TencentDB startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
