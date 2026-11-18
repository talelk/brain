import { PASSWORD, type Api, type Stack } from "./stack";

/** Invites an address as the first admin and opens the link as the person, the way the Accept page does: they have an account and what the invitation granted. */
export async function joinPerson(stack: Stack, api: Api, email: string, name: string, grants: { workspaces?: Array<{ workspaceId: string; role: "viewer" | "member" | "admin" }>; groups?: string[]; instanceAdmin?: boolean } = {}): Promise<string> {
  const invited = await api.command("user.invite", { email, workspaces: grants.workspaces ?? [], groups: grants.groups ?? [], instanceAdmin: grants.instanceAdmin ?? false });
  const response = await fetch(`${stack.url}/v1/command`, {
    method: "POST", headers: { "content-type": "application/json", origin: stack.url },
    body: JSON.stringify({ type: "invitation.accept", idempotencyKey: crypto.randomUUID(), input: { token: invited.link.split("=")[1], name, password: PASSWORD } }),
  });
  if (!response.ok) throw new Error(`accepting the invitation of ${email} failed: ${await response.text()}`);
  return ((await response.json()) as { output: { userId: string } }).output.userId;
}
