import type { Governor } from "../app";
import { append } from "../events";
import { referencedSecrets } from "../workspace/load";
import { activeManifest } from "../workspace/store";
import { verify } from "./audit";
import { deleteSecret, listSecrets, setSecret } from "./secrets";

export function registerTrust({ gov: { registry } }: Governor): void {
  registry.command("secret.set", (ctx, input) => {
    setSecret(ctx.gov, ctx.db, { workspaceId: input.workspaceId, name: input.name, value: input.value, by: ctx.actor.id });
    append(ctx.db, { type: "secret.set", workspaceId: input.workspaceId, subject: `secret:${input.name}`, payload: { name: input.name }, actor: ctx.actor });
    return {};
  });
  registry.command("secret.delete", (ctx, input) => {
    if (deleteSecret(ctx.db, input.workspaceId, input.name)) append(ctx.db, { type: "secret.deleted", workspaceId: input.workspaceId, subject: `secret:${input.name}`, payload: { name: input.name }, actor: ctx.actor });
    return {};
  });
  registry.query("secrets.list", (ctx, input) => {
    const secrets = listSecrets(ctx.db, input.workspaceId);
    const set = new Set(secrets.map((secret) => secret.name));
    return { secrets, missing: referencedSecrets(activeManifest(ctx.gov, input.workspaceId)).filter((name) => !set.has(name)) };
  });
  registry.query("audit.verify", (ctx) => verify(ctx.db));
}
