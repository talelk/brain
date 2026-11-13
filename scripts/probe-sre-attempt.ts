/**
 * Manual check (not part of any gate): one SRE operator attempt through the REAL PiEngine against the REAL local model, with a fake host
 * behind the tools, to see what an attempt costs per turn. It exists because a task as small as "Run docker.ps" once used 110k tokens per
 * attempt on the demos server while its tool answers were tiny: the cost is turns (each re-sends the prompt and the conversation), not output.
 *
 *   BRAIN_LOCAL_MODEL_URL=http://tntungx10:8000/v1 pnpm tsx scripts/probe-sre-attempt.ts simple|report [--no-context]
 *
 * Reads the model endpoint from the environment (default as the runner), the instructions from the starter release, the context pack from
 * scripts/demo/sre-demos/*.md (built with the Governor's own pack builder, as handoff notes), and answers host.exec with captured real
 * outputs when a directory of them is given in BRAIN_SRE_FIXTURES (docker-ps.txt, docker-stats.txt; a short plausible text otherwise).
 * Prints one line per turn (prompt/completion tokens, tool calls, text) and a summary. Success: simple < 30k tokens, report < 60k, both
 * with a complete JSON answer. The model server is shared: run one at a time.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";
import { buildContextPack, type PackSection } from "../apps/governor/src/modules/sessions/context-pack";
import { contextBudget } from "../apps/governor/src/modules/jobs/attempts";
import { PiEngine } from "../apps/runner/src/engines/pi";
import { promptWithContext, runAgentExecution } from "../apps/runner/src/engines/run";

const root = new URL("..", import.meta.url).pathname;
const which = process.argv[2] === "report" ? "report" : "simple";
const withContext = !process.argv.includes("--no-context");
const fixtures = process.env["BRAIN_SRE_FIXTURES"];
const agentDir = join(process.env["TMPDIR"] ?? tmpdir(), `sre-probe-${process.pid}`);
mkdirSync(agentDir, { recursive: true });
process.env["BRAIN_PI_AGENT_DIR"] = agentDir;

const instructions = readFileSync(join(root, "examples/v1/starter-release/agents/sre-operator.md"), "utf8");
const TOOLS: ReadonlyArray<[string, string, "read" | "write"]> = [
  ["host.read", "host-read-input.json", "read"], ["host.exec", "host-exec-input.json", "read"], ["documents.read", "documents-read-input.json", "read"],
  ["knowledge.search", "knowledge-search-input.json", "read"], ["host.restart", "host-restart-input.json", "write"], ["host.reload", "host-reload-input.json", "write"],
  ["ticket.create", "ticket-create-input.json", "write"], ["message.send", "message-send-input.json", "write"], ["git.open-pr", "git-open-pr-input.json", "write"],
];
const digest = (c: string): string => `sha256:${c.repeat(64)}`;
const bindings: EngineToolBinding[] = TOOLS.map(([id, schema, effectClass], index) => ({
  release: { id, digest: digest("abcdef0123456789"[index % 16]!) }, effectClass,
  inputSchema: JSON.parse(readFileSync(join(root, "examples/v1/starter-release/schemas", schema), "utf8")),
  target: { targetId: "demos-host", environmentId: "local", preconditionDigest: digest("b") },
} as EngineToolBinding));

const fixture = (name: string, fallback: string): string => (fixtures && existsSync(join(fixtures, name)) ? readFileSync(join(fixtures, name), "utf8") : fallback);
const EXEC: Record<string, string> = {
  "docker.ps": fixture("docker-ps.txt", "brain-governor-1\tUp 4 hours (healthy)\nweb-1\tUp 2 days\n"),
  "docker.stats": fixture("docker-stats.txt", "brain-governor-1\t19.29%\t298.3MiB / 3GiB\nweb-1\t0.03%\t224.9MiB / 8GiB\n"),
  "docker.df": "TYPE\tTOTAL\tACTIVE\tSIZE\tRECLAIMABLE\nImages\t52\t34\t41.2GB\t12.8GB (31%)\nContainers\t41\t34\t1.1GB\t0B\nLocal Volumes\t60\t30\t18.4GB\t6.1GB (33%)",
  "host.df": "Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  1.8T  1.1T  600G  65% /srv",
  "host.memory": "              total        used        free      shared  buff/cache   available\nMem:          125Gi        42Gi        18Gi       1.1Gi        65Gi        82Gi\nSwap:         8.0Gi       0.5Gi       7.5Gi",
  "host.uptime": " 10:21:04 up 31 days,  3:12,  2 users,  load average: 1.21, 1.43, 1.38",
  "host.du": "44G\t/srv/demos/backups\n21G\t/srv/demos/newqlik\n9.3G\t/srv/demos/cvinsights\n4.1G\t/srv/demos/brain",
  "http.check-demos": "brain 200\ncvinsights 200\nhealth360 200\nnewqlik 200\nzain-docus 200\nps-insights 200",
};
const LOG = "2026-11-13T09:58:01Z INFO request handled path=/v1/doctor status=200 ms=4\n".repeat(20);
function answerTool(tool: string, input: Record<string, JsonValue>): JsonValue {
  if (tool === "host.exec") {
    const command = String(input["command"]);
    const text = command === "docker.logs" ? LOG : (EXEC[command] ?? "active");
    return { command, exitCode: 0, output: text, errorOutput: "", timedOut: false, truncated: false };
  }
  if (tool === "host.read") {
    const op = String(input["op"]);
    if (op === "list") return { op, path: String(input["path"] ?? ""), entries: [{ name: "gatus", type: "dir", bytes: 4096, modified: 1794000000 }, { name: "brain", type: "dir", bytes: 4096, modified: 1794000000 }], hidden: 0, truncated: false };
    if (op === "read") return { op, path: String(input["path"] ?? ""), text: "services:\n  web:\n    image: example/web:1.4\n    restart: unless-stopped\n    mem_limit: 512m\n", hidden: 0, truncated: false };
    return { op, path: String(input["path"] ?? ""), matches: ["demos/gatus/config/config.yaml"], hidden: 0, truncated: false };
  }
  if (tool.startsWith("host.re") || tool === "ticket.create" || tool === "message.send" || tool === "git.open-pr") return { held: true, summary: "The change is held until the owner decides it." };
  return { matches: [], note: "nothing found" };
}

const SIMPLE = {
  title: "Run docker.ps to enumerate running containers",
  criteria: ["The result lists all running containers with their image names", "The result cites the tool call that showed each fact"],
};
const REPORT = {
  title: "Compile the SRE report for the demos server",
  criteria: ["The report states how many containers are running and which are unhealthy, citing the tool call", "The report lists the ten largest containers by memory and every container with no memory limit", "The report gives disk and memory headroom for /srv and the host, citing the tool call", "Every proposed fix names the call that showed the need, its risk and how to undo it"],
  upstream: "Upstream results:\n- Enumerate running containers: 34 containers are running; brain-governor-1 healthy; tdai-proxy healthy (docker.ps).\n- Check disk and memory: /srv is 65% used with 600G free; 42Gi of 125Gi memory used (host.df, host.memory).\n\nUpstream deliverables (what those tasks wrote):\n> # Containers\n> 34 containers are up, none exited. Largest by memory: newqlik-query-1 2.0GiB, newqlik-build-1 1.9GiB, cvinsights-web-1 0.96GiB.\n> # Host\n> /srv 65% used, 600G free; memory 82Gi available.",
};
const task = which === "report" ? REPORT : SIMPLE;
const situation = `${task.title}\nAcceptance criteria:\n${task.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}${"upstream" in task ? `\n\n${task.upstream}` : ""}`;
const taskText = JSON.stringify({ situation });

const notes = ["runbook.md", "inventory.md", "monitoring.md"].map((name) => ({ name, text: readFileSync(join(root, "scripts/demo/sre-demos", name), "utf8").trim() }));
const sections: PackSection[] = [
  { id: "brief", title: "Mission brief and this task's criteria", label: "fact", items: [
    { id: "goal", prose: false, text: "Goal: Keep the demos server healthy and know what runs on it" },
    { id: "task", prose: false, text: `This task: ${task.title}` },
    { id: "criteria", prose: false, text: `This task's acceptance criteria:\n${task.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}` },
  ] },
  { id: "handoff-notes", title: "Handoff notes from those tasks (written by the member)", label: "claim", items: notes.map((note) => ({ id: note.name, prose: true, label: `Handoff note from ${note.name}`, text: `- ${note.name}: ${note.text}` })) },
];
const budget = contextBudget(100_000, taskText);
const pack = withContext ? buildContextPack({ sections, budgetTokens: budget, identity: { runId: "run", jobId: "job", workItemId: "wi", agentId: "sre-operator" } }) : undefined;
const prompt = promptWithContext(taskText, pack);

const t0 = Date.now();
let turn = 0;
const engine = new PiEngine(bindings);
console.log(`task=${which} instructions=${instructions.length} chars, pack=${pack ? pack.text.length : 0} chars (budget ${budget} tokens), prompt=${prompt.length} chars`);
const result = await runAgentExecution({
  engine, attemptId: "att-probe", jobFence: 1, leaseId: "l", runnerId: "r", organizationId: "o", workspaceId: "w", jobId: "j", configDigest: digest("d"),
  instructions, task: prompt, timeoutMs: 900_000, maxTurns: 30, maxTokens: 100_000, maxMicroUsd: 0, allowedTools: bindings.map((binding) => binding.release),
  signal: new AbortController().signal,
  onSession: () => {
    const session = (engine as unknown as { session: { subscribe: (fn: (event: any) => void) => void } }).session; // eslint-disable-line @typescript-eslint/no-explicit-any
    session.subscribe((event) => {
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      turn += 1;
      const message = event.message;
      const parts = (message.content ?? []) as Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>;
      const calls = parts.filter((part) => part.type === "toolCall").map((part) => `${part.name}(${JSON.stringify(part.arguments)})`);
      const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("").replace(/\s+/gu, " ").slice(0, 160);
      const thinking = parts.filter((part) => part.type === "thinking").map((part) => part.thinking ?? "").join("").length;
      const usage = message.usage ?? {};
      console.log(`turn ${turn} prompt=${usage.input ?? "?"} cacheRead=${usage.cacheRead ?? 0} completion=${usage.output ?? "?"} thinkingChars=${thinking} stop=${message.stopReason} calls=[${calls.join("; ")}] text="${text}"`);
    });
  },
  executeTool: async (proposal): Promise<EngineToolExecutionResult> => {
    const output = answerTool(proposal.tool.id, proposal.input as Record<string, JsonValue>);
    return { proposalId: proposal.proposalId, invocationId: proposal.proposalId, output, receipt: { result: "succeeded" } as never };
  },
  emit: async (_kind, payload) => {
    const event = payload as { kind?: string; payload?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
    if (event.kind === "usage") console.log(`usage input=${event.payload?.inputTokens} output=${event.payload?.outputTokens} cached=${event.payload?.cachedInputTokens}`);
  },
});
const out = result.output as { error?: string; summary?: string; criteria?: unknown[] };
console.log(`\nok=${result.ok} seconds=${Math.round((Date.now() - t0) / 1000)} turns=${turn}`);
console.log(out.error ? `ERROR ${out.error}` : `keys: ${Object.keys(out).join(",")}\nsummary: ${String(out.summary).slice(0, 300)}\ncriteria answered: ${out.criteria?.length ?? 0} of ${task.criteria.length}`);
process.exit(0);
