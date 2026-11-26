/** Wire types between a runner and the launcher beside it, over the launcher's Unix socket (docs/architecture.md section 6). */

export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }

/** One run of a tool's `run.sh` in a tool sandbox. The launcher finds the tool's files and the working copy under the attempt's directory. */
export interface ToolRun {
  readonly attemptId: string;
  readonly tool: string;
  /** Names the container; one per call. */
  readonly requestId: string;
  /** The tool's `network` hosts: what its sandbox reaches through the egress proxy. None means no network. */
  readonly egressHosts: readonly string[];
  /** The validated input, as JSON, on the script's standard input. */
  readonly input: string;
  readonly timeoutMs: number;
  /** The tool's leased secrets, as environment variables of this one run. */
  readonly secretEnv: Readonly<Record<string, string>>;
}

/** How a sandbox is given the working copy at `/work`: not at all, read-only, or read-write. */
export type WorkMount = "none" | "ro" | "rw";

/** What the runner asks the launcher for: one engine process, in its own container, for one attempt. */
export interface EngineSandboxRequest {
  readonly engine: string;
  /** Names the attempt's directory on the host: the launcher mounts its `work`, `out` and `state` folders. */
  readonly attemptId: string;
  /** Names this container (and makes a repeated request the same container). */
  readonly requestId: string;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  readonly work: WorkMount;
  /** The model gateway's host and the projects' hosts: the whole network the container gets, through the egress proxy. */
  readonly egressHosts: readonly string[];
}

/** The fields each request may have: the launcher refuses any other. */
export const TOOL_RUN_FIELDS = ["attemptId", "tool", "requestId", "egressHosts", "input", "timeoutMs", "secretEnv"] as const satisfies readonly (keyof ToolRun)[];
export const ENGINE_SANDBOX_FIELDS = ["engine", "attemptId", "requestId", "cpuMillicores", "memoryMb", "egressHosts", "work"] as const satisfies readonly (keyof EngineSandboxRequest)[];

/** An attempt id names a folder on the runner host, so it is checked before it becomes part of a path. */
export const isAttemptId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !value.includes("..");
