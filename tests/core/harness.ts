import { BrainError, type ApiResponse, type CommandOutputs, type CommandRequest, type CommandType, type QueryOutputs, type QueryRequest, type QueryType } from "@brain/contracts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGovernor, type Governor, type GovernorOptions } from "../../apps/governor/src/app";

/** A Governor on a temporary data directory, set up, with clients that call it as a given person over its real HTTP surface. */
export const BASE_URL = "http://localhost:3100";
export const FIXTURE_PACKS = fileURLToPath(new URL("../fixtures/packs", import.meta.url));
export const PASSWORD = "correct horse battery";

export interface Client {
  command<T extends CommandType>(type: T, input: CommandRequest<T>, idempotencyKey?: string): Promise<CommandOutputs[T]>;
  query<T extends QueryType>(type: T, input: QueryRequest<T>): Promise<QueryOutputs[T]>;
  /** Any request, with this person's cookies. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
export interface Harness {
  readonly governor: Governor;
  readonly dataDir: string;
  /** The person setup created: the instance admin. */
  readonly admin: Client;
  /** Nobody signed in. */
  readonly anonymous: Client;
  /** Creates a workspace from the fixture packs, as the instance admin. */
  createWorkspace(input?: Partial<CommandRequest<"workspace.create">>): Promise<CommandOutputs["workspace.create"]>;
  /** Adds a person to a workspace (creating their account) and returns a client signed in as them. */
  member(workspaceId: string, email: string, role: "viewer" | "member" | "admin"): Promise<Client>;
  signIn(email: string, password?: string): Promise<Client>;
  /** Stops the Governor and starts another on the same data directory. */
  restart(): Promise<void>;
  close(): void;
}

const cookieHeader = (setCookies: readonly string[]): string => setCookies.map((cookie) => cookie.split(";")[0]).join("; ");

export async function startGovernor(options: Partial<GovernorOptions> = {}): Promise<{ governor: Governor; dataDir: string; client(cookies?: string): Client }> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "brain-test-"));
  const governor = await createGovernor({ dataDir, baseUrl: BASE_URL, packsDir: FIXTURE_PACKS, ...options });
  const client = (cookies = ""): Client => {
    const fetch = (path: string, init: RequestInit = {}): Promise<Response> =>
      Promise.resolve(governor.app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers: { origin: BASE_URL, ...(cookies ? { cookie: cookies } : {}), ...(init.headers as Record<string, string> | undefined) } })));
    const call = async (path: string, body: unknown): Promise<unknown> => {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json()) as ApiResponse<unknown>;
      if ("error" in answer) throw new BrainError(answer.error.code, answer.error.message, answer.error.problems);
      return answer.output;
    };
    return {
      fetch,
      command: (type, input, idempotencyKey = randomUUID()) => call("/v1/command", { type, input, idempotencyKey }) as never,
      query: (type, input) => call("/v1/query", { type, input }) as never,
    };
  };
  return { governor, dataDir, client };
}

export async function createHarness(options: Partial<GovernorOptions> = {}): Promise<Harness> {
  let running = await startGovernor(options);
  const { dataDir } = running;
  const signIn = async (email: string, password = PASSWORD): Promise<Client> => {
    const response = await running.client().fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!response.ok) throw new Error(`sign-in of ${email} failed: ${response.status} ${await response.text()}`);
    return running.client(cookieHeader(response.headers.getSetCookie()));
  };
  // Setup signs the first person in: its answer carries the session cookies.
  const setup = await running.client().fetch("/v1/command", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "setup.create", idempotencyKey: randomUUID(), input: { token: readFileSync(join(dataDir, "setup.token"), "utf8").trim(), name: "Ada Admin", email: "ada@example.com", password: PASSWORD } }),
  });
  if (!setup.ok) throw new Error(`setup failed: ${await setup.text()}`);
  const adminCookies = cookieHeader(setup.headers.getSetCookie());
  const harness: Harness = {
    get governor() { return running.governor; },
    dataDir,
    get admin() { return running.client(adminCookies); },
    get anonymous() { return running.client(); },
    createWorkspace: (input = {}) => harness.admin.command("workspace.create", { name: "Test workspace", packs: ["extra"], ...input }),
    async member(workspaceId, email, role) {
      await harness.admin.command("member.set", { workspaceId, email, role, name: email.split("@")[0] ?? email, password: PASSWORD });
      return signIn(email);
    },
    signIn,
    async restart() {
      running.governor.close();
      running = await startGovernor({ ...options, dataDir });
    },
    close() {
      running.governor.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}
