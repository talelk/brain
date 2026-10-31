import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Brain } from "../apps/governor/src/application/brain";
import { collectRelease } from "../apps/cli/src/release";
import { credentialStore } from "../apps/cli/src/credentials";
import { connectLocalModel } from "../apps/governor/src/modules/operations/index";

const dataDir = process.env["BRAIN_DATA_DIR"]!;
const stateFile = join(dataDir, "first-launch.json");
const adminEmail = process.env["BRAIN_ADMIN_EMAIL"] ?? "admin@brain.local";
const adminPassword = process.env["BRAIN_ADMIN_PASSWORD"] ?? "admin-password";
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const brain = new Brain({ dataDir });
try {
  await brain.auth.ready();
  const existing = brain.store.control.prepare("SELECT id FROM organizations LIMIT 1").get();
  if (existing && !existsSync(stateFile)) { console.log("Existing installation preserved."); }
  else {
    let state: { organizationId: string; workspaceId: string; completed: boolean };
    if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, "utf8"));
    else {
      state = { organizationId: `org-${randomUUID()}`, workspaceId: `ws-${randomUUID()}`, completed: false };
      writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    }
    if (!state.completed) {
      let sessionToken: string;
      if (!existing) {
        const result = await brain.bootstrap({ email: adminEmail, password: adminPassword, name: "My organization", organizationId: state.organizationId }, readFileSync(join(dataDir, "setup.token"), "utf8").trim());
        sessionToken = result.sessionToken;
      } else {
        const account = await brain.auth.bootstrapAccount({ email: adminEmail, password: adminPassword, name: "Administrator" });
        sessionToken = account.token;
      }
      const headers = new Headers({ authorization: `Bearer ${sessionToken}` });
      const identity = await brain.resolveActor(headers);
      if (!brain.store.control.prepare("SELECT 1 FROM workspaces WHERE id=?").get(state.workspaceId)) brain.createWorkspace(identity.actor, { workspaceId: state.workspaceId, slug: "My workspace" });
      const bundle = collectRelease("examples/v1/starter-release");
      bundle.documents = bundle.documents.map((doc) => ({ ...doc, text: doc.text.replaceAll('"org-local"', JSON.stringify(state.organizationId)).replaceAll('"operations"', JSON.stringify(state.workspaceId)).replace('"displayName": "Operations"', '"displayName": "My workspace"') }));
      const { digest } = brain.stageRelease(identity.actor, bundle.documents, `sha256:${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}`, bundle.scripts, bundle.instructions, bundle.schemas);
      const active = brain.store.control.prepare("SELECT release_digest FROM active_config WHERE organization_id=?").get(state.organizationId) as { release_digest: string } | undefined;
      if (!active) brain.activateRelease(identity.actor, digest, null);
      brain.store.control.prepare("UPDATE user SET name='Administrator' WHERE id=?").run(identity.principalId);
      if (process.env["BRAIN_LOCAL_RUNTIME_DIR"]) {
        const apiKey = process.env["BRAIN_LOCAL_MODEL_API_KEY"];
        await connectLocalModel(brain.store, identity.actor, {
          modelUrl: process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1",
          modelId: process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b",
          ...(apiKey ? { apiKey } : {}),
        });
        console.log("Connected the default model and prepared scoped Pi and Claude runners.");
      }
      credentialStore(process.env["BRAIN_GOVERNOR_URL"]!, process.env).save(sessionToken);
      state.completed = true;
      writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      console.log(`Created administrator ${adminEmail}, My workspace, starter workflows and governed tools.${process.env["BRAIN_ADMIN_PASSWORD"] ? "" : " Default local password: admin-password"}`);
    }
  }
} finally { brain.close(); }
