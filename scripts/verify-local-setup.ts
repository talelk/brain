import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IdentityView, LocalRuntimeStatus, OperationalReadiness, WorkflowCatalogEntry, JobSnapshot, VerificationVerdict, ConversationView, TaskDraft } from "../packages/contracts/src/index";

const root = mkdtempSync(join(tmpdir(), "brain-local-setup-proof-"));
const evidence = resolve(process.env["BRAIN_LOCAL_SETUP_EVIDENCE_DIR"] ?? `artifacts/implementation/local-setup-${Date.now()}`);
mkdirSync(evidence, { recursive: true });
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, BRAIN_INSTANCE_DIR: root, BRAIN_DATA_DIR: join(root, "data"), BRAIN_RUN_DIR: join(root, "run"), BRAIN_CLI_STATE_DIR: join(root, "cli"), BRAIN_PORT: String(port), BRAIN_GOVERNOR_URL: url, BRAIN_BASE_URL: url, BRAIN_AUTH_REQUIRE_2FA: "false" };
const sourcePaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter((path) => /^(apps|packages|contracts|scripts|tests|examples)\//u.test(path) || ["package.json", "pnpm-lock.yaml"].includes(path));
function fingerprint() { const hash = createHash("sha256"); for (const path of [...new Set(sourcePaths)].sort()) if (existsSync(path)) hash.update(path).update(readFileSync(path)); return hash.digest("hex"); }
const initialFingerprint = fingerprint();
let token = "";
const record: Record<string, unknown> = { root, evidence, startedAt: new Date().toISOString(), sourceFingerprint: initialFingerprint, modelUrl: process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1", modelId: process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b", runs: [] };
async function lifecycle(action: string, args: string[] = []) {
  console.log(`Local setup proof: ${action}`);
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/brain.ts", action, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); }); child.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timer); writeFileSync(join(evidence, `${action}-${Date.now()}.log`), output);
  assert.equal(code, 0, `${action} failed; see lifecycle log in ${evidence}`);
}
async function api<T>(path: string, body?: unknown, authenticated = true): Promise<T> {
  const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: url, ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const error = await response.json() as { code?: string; message?: string; error?: { code?: string; message?: string } };
    throw new Error(`${path}: HTTP ${response.status}: ${error.code ?? error.error?.code ?? "request failed"}: ${error.message ?? error.error?.message ?? ""}`);
  }
  return await response.json() as T;
}
async function until<T>(description: string, read: () => Promise<T>, accept: (value: T) => boolean, timeout = 60000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise((resolve) => setTimeout(resolve, 500)); }
  throw new Error(`${description}: timed out`);
}
try {
  await lifecycle("start");
  record.phase = "default administrator sign-in";
  token = (await api<{ token: string }>("/api/auth/sign-in/email", { email: "admin@brain.local", password: "admin-password" }, false)).token;
  const identity = await api<IdentityView>("/v1/identity");
  assert.equal(identity.workspaces.length, 1);
  assert.equal(identity.passwordChangeRequired, false);
  assert.equal(existsSync(join(root, "data", "initial-admin-password")), false);
  const workspaceId = identity.workspaces[0]!.workspaceId;
  record.workspaceId = workspaceId;
  const catalog = await api<{ snapshot: { items: WorkflowCatalogEntry[] } }>("/v1/query", { queryType: "workflows.list", workspaceId });
  assert(catalog.snapshot.items.some((item) => item.release.id === "operations-triage"));
  assert(catalog.snapshot.items.some((item) => item.release.id === "support-draft"));
  await api("/v1/local-runtime/connect", { modelUrl: record.modelUrl, modelId: record.modelId });
  await until("local runners", () => api<LocalRuntimeStatus>("/v1/local-runtime"), (status) => status.runners.every((runner) => runner.applied));
  for (const [id, input] of [["agent-smoke", { message: "BRAIN_OK" }], ["operations-triage", { situation: "Error rates increased after deployment. No rollback attempted. Identify missing facts and read-only next checks." }], ["support-draft", { title: "Session expired", body: "I cannot sign in. Draft a response requesting diagnostic information; do not send it." }]] as const) {
    const workflow = catalog.snapshot.items.find((item) => item.release.id === id)!;
    const receipt = await api<{ accepted: boolean; resourceId: string }>("/v1/commands", { contractVersion: "brain.command/v1", commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "workflow.dispatch", workspaceId, payload: { workflow: workflow.release, input } });
    assert(receipt.accepted);
    const job = await until(id, () => api<{ snapshot: JobSnapshot }>("/v1/query", { queryType: "job.get", workspaceId, resourceId: receipt.resourceId }), (view) => {
      if (["failed", "cancelled", "outcome_unknown"].includes((view.snapshot.workflowState ?? view.snapshot.state))) { writeFileSync(join(evidence, `${id}-failure.json`), JSON.stringify(view, null, 2)); throw new Error(`${id}: ${view.snapshot.workflowState ?? view.snapshot.state}`); }
      return view.snapshot.workflowState === "succeeded" && !!view.snapshot.evidenceDigest;
    }, 240000);
    const verification = await api<{ snapshot: { verdict: VerificationVerdict } }>("/v1/query", { queryType: "evidence.get", workspaceId, resourceId: job.snapshot.evidenceDigest });
    assert.equal(verification.snapshot.verdict.outcome, "verified");
    (record.runs as unknown[]).push({ workflow: id, runId: receipt.resourceId, job: job.snapshot, verdict: verification.snapshot.verdict });
    writeFileSync(join(evidence, "run.json"), JSON.stringify(record, null, 2));
    console.log(`Local setup proof: ${id} independently verified`);
  }
  const conversationId = randomUUID();
  await api("/v1/conversations", { workspaceId, id: conversationId });
  await api(`/v1/conversations/${conversationId}/messages`, { workspaceId, id: randomUUID(), text: "Prepare support-draft. Title: Session expired. Body: I cannot sign in after my session expired. Draft a concise response asking for diagnostic details. Do not send it." });
  const conversation = await until("verified conversation proposal", () => api<ConversationView>(`/v1/conversations/${conversationId}?workspaceId=${workspaceId}`), (view) => {
    if (view.messages.some((message) => message.state === "failed")) { writeFileSync(join(evidence, "conversation-failure.json"), JSON.stringify(view, null, 2)); throw new Error("Conversation helper failed independent verification"); }
    if (view.messages.some((message) => message.role === "assistant" && message.state === "done" && !message.draftId)) { writeFileSync(join(evidence, "conversation-questions.json"), JSON.stringify(view, null, 2)); throw new Error("Conversation asked for more input rather than preparing the complete supplied task"); }
    return view.messages.some((message) => message.draftId);
  }, 240000);
  const proposalId = conversation.messages.find((message) => message.draftId)!.draftId!;
  const proposal = await api<TaskDraft>(`/v1/tasks/drafts/${proposalId}?workspaceId=${workspaceId}`);
  assert.equal(proposal.state, "review"); assert.equal(proposal.runId, undefined);
  const startedProposal = await api<TaskDraft>(`/v1/tasks/drafts/${proposalId}/start`, { workspaceId });
  assert.equal((await api<TaskDraft>(`/v1/tasks/drafts/${proposalId}/start`, { workspaceId })).runId, startedProposal.runId);
  const completedProposal = await until("confirmed conversation task", () => api<{ snapshot: JobSnapshot }>("/v1/query", { queryType: "job.get", workspaceId, resourceId: startedProposal.runId }), (view) => {
    if (view.snapshot.workflowState === "failed") throw new Error("Confirmed conversation task failed");
    return view.snapshot.workflowState === "succeeded";
  }, 240000);
  record.conversation = { conversationId, proposal, confirmedRunId: startedProposal.runId, result: completedProposal.snapshot };
  console.log("Local setup proof: live conversation proposal required explicit confirmation and completed");
  const card = await api<{ resourceId: string }>("/v1/commands", { contractVersion: "brain.command/v1", commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "board.create", workspaceId, payload: { title: "Investigate deployment latency", criteria: ["Identify missing observations"] } });
  const context = await api<{ workflowId: string; input: unknown }>(`/v1/task-context?workspaceId=${workspaceId}&kind=card&id=${card.resourceId}`);
  const workDraft = await api<TaskDraft>("/v1/tasks/drafts", { workspaceId, workflowId: context.workflowId, input: context.input, origin: { kind: "work-item", id: card.resourceId } });
  const workStarted = await api<TaskDraft>(`/v1/tasks/drafts/${workDraft.id}/start`, { workspaceId });
  const completedWork = await until("work item task", () => api<{ snapshot: JobSnapshot }>("/v1/query", { queryType: "job.get", workspaceId, resourceId: workStarted.runId }), (view) => {
    if (view.snapshot.workflowState === "failed") throw new Error("Work-item task failed");
    return view.snapshot.workflowState === "succeeded";
  }, 240000);
  assert.equal(completedWork.snapshot.origin?.id, card.resourceId);
  record.workItem = { cardId: card.resourceId, draftId: workDraft.id, runId: workStarted.runId, result: completedWork.snapshot };
  writeFileSync(join(evidence, "run.json"), JSON.stringify(record, null, 2));
  const ready = await api<OperationalReadiness>(`/v1/doctor?workspaceId=${workspaceId}`);
  assert(ready.smokeVerified && ready.ready);
  record.readiness = ready;
  await lifecycle("stop");
  await lifecycle("start");
  const restored = await api<IdentityView>("/v1/identity");
  assert.equal(restored.workspaces[0]?.workspaceId, workspaceId);
  await until("runner restart", () => api<LocalRuntimeStatus>("/v1/local-runtime"), (status) => status.runners.every((runner) => runner.applied));
  record.restartVerified = true;
  const backup = join(root, "backup");
  await lifecycle("backup", [backup]);
  assert(existsSync(join(backup, "manifest.json")));
  record.backupVerified = true;
  await lifecycle("reset", ["--yes"]);
  assert.equal(existsSync(join(root, "data")), false); assert.equal(existsSync(join(root, "run")), false); assert.equal(existsSync(join(root, "cli")), false);
  await lifecycle("start");
  token = (await api<{ token: string }>("/api/auth/sign-in/email", { email: "admin@brain.local", password: "admin-password" }, false)).token;
  const fresh = await api<IdentityView>("/v1/identity"); assert.equal(fresh.passwordChangeRequired, false); assert.notEqual(fresh.workspaces[0]?.workspaceId, workspaceId);
  assert.equal(existsSync(join(root, "data", "local-model.json")), false);
  record.resetVerified = true;
  console.log("Local setup proof: reset erased all managed state and regenerated fresh defaults");
  await lifecycle("reset", ["--yes"]);
  assert(existsSync(join(backup, "manifest.json")), "reset must preserve explicit backups");
  await lifecycle("restore", [backup]);
  assert(existsSync(join(root, "data", "RESTORED-SUSPENDED.json")));
  await lifecycle("start");
  const restoredDb = new Database(join(root, "data", "control.db"), { readonly: true });
  try {
    assert.deepEqual(restoredDb.prepare("SELECT status FROM workspaces WHERE id=?").get(workspaceId), { status: "restore_pending" });
  } finally { restoredDb.close(); }
  record.restoreVerified = true;
  console.log("Local setup proof: backup survived reset; restored workspace remains suspended");
  assert.equal(fingerprint(), initialFingerprint, "source changed during proof");
  record.passed = true;
} catch (error) { record.passed = false; record.failure = error instanceof Error ? error.message : "local setup failed"; process.exitCode = 1; }
finally {
  try { await lifecycle("stop"); } catch (error) { record.teardownFailure = error instanceof Error ? error.message : "stop failed"; process.exitCode = 1; }
  record.completedAt = new Date().toISOString();
  writeFileSync(join(evidence, "run.json"), JSON.stringify(record, null, 2));
  console.log(`Local setup evidence: ${evidence}`);
}
