import { join } from "node:path";
import { isToolName, TOOL_RUN_FIELDS } from "@brain/contracts";
import { execa } from "execa";
import { attemptFolder, egressHosts, hardening, isDirectory, network, refuse, type Reply, type SandboxOptions, slug, whenCreated } from "./sandbox-common";

/**
 * The tool sandbox: one container for one run of a tool's `run.sh`. It sees the tool's files read-only at `/tools`, the attempt's working
 * copy read-only at `/work` (its working directory), the attempt's `/out` read-write (a tool that builds a deliverable saves it there), and a small `/tmp`. Its network is the tool's own `network` hosts on the egress
 * proxy, or none. The tool's leased secrets are environment variables of this one run: named on the docker command line, valued in the
 * docker client's own environment, so they are never on an argv another process can read. The input is the script's standard input.
 */
export const TOOL_IMAGE = "brain-sandbox-tool";
export const TOOL_LABEL = "brain.tool-run";
const TOOL_CPU_MILLICORES = 1000;
const TOOL_MEMORY_MB = 1024;
const TOOL_PIDS = 512;

interface ToolSandboxShape {
  readonly name: string;
  readonly requestId: string;
  /** The host folder of the tool's files and of the attempt's working copy, already checked to be under the operator's root. */
  readonly toolDirectory: string;
  readonly workDirectory: string;
  /** The attempt's `out` folder, when it exists. */
  readonly outDirectory?: string;
  readonly user: string;
  readonly network: readonly string[];
  readonly secretNames: readonly string[];
}

/** The `docker run` argv of a tool run: nothing in it comes from the caller except the values named in the shape. */
function toolSandboxArgs(shape: ToolSandboxShape): string[] {
  return ["run", "-i", "--rm", "--name", shape.name, ...shape.network,
    ...hardening(TOOL_CPU_MILLICORES, TOOL_MEMORY_MB, TOOL_PIDS, shape.user, 64),
    "-v", `${shape.toolDirectory}:/tools:ro`, "-v", `${shape.workDirectory}:/work:ro`, ...(shape.outDirectory ? ["-v", `${shape.outDirectory}:/out:rw`] : []), "-w", "/work",
    "-e", "HOME=/tmp", "-e", "TMPDIR=/tmp", "-e", "LANG=C.UTF-8", ...shape.secretNames.flatMap((name) => ["-e", name]),
    "--label", `${TOOL_LABEL}=${shape.requestId}`,
    TOOL_IMAGE, "/bin/bash", "/tools/run.sh"];
}

export async function runTool(options: SandboxOptions, body: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
  for (const key of Object.keys(body)) if (!(TOOL_RUN_FIELDS as readonly string[]).includes(key)) return refuse(422, `field ${key} forbidden`);
  const tool = String(body["tool"] ?? "");
  if (!isToolName(tool)) return refuse(422, "tool invalid");
  const requestId = String(body["requestId"] ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId)) return refuse(422, "requestId invalid");
  const input = String(body["input"] ?? "");
  if (Buffer.byteLength(input, "utf8") > 64 * 1024) return refuse(413, "input too large");
  const timeoutMs = Math.min(3_600_000, Math.max(1000, Number(body["timeoutMs"] ?? 60_000)));
  const secretEnv = body["secretEnv"] ?? {};
  if (typeof secretEnv !== "object" || secretEnv === null || Array.isArray(secretEnv) || Object.keys(secretEnv).length > 16) return refuse(422, "secretEnv must be an object of at most 16 values");
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(secretEnv as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || /^(?:PATH|HOME|LD_|DYLD_|DOCKER_|GIT_|SSL_)/u.test(name) || typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 8192) return refuse(422, `secretEnv ${name} is invalid`);
    secrets[name] = value;
  }
  const hosts = egressHosts(body["egressHosts"], options.egressGrantsDir);
  if (!hosts.ok) return hosts.reply;
  const folder = attemptFolder(options.attemptsRoot, String(body["attemptId"] ?? ""));
  if (!folder.ok) return folder.reply;
  const toolDirectory = join(folder.directory, "tools", tool);
  const workDirectory = join(folder.directory, "work");
  const outDirectory = join(folder.directory, "out");
  if (!isDirectory(toolDirectory) || !isDirectory(workDirectory)) return refuse(409, "the tool's files or the working copy are absent in the attempt's folder");
  const unverified = await options.verifyImage(TOOL_IMAGE);
  if (unverified) return refuse(409, unverified);

  const name = `brain-tool-${slug(requestId)}-${Date.now().toString(36)}`;
  const net = await network(hosts.hosts, options.egressGrantsDir);
  try {
    const args = toolSandboxArgs({ name, requestId, toolDirectory, workDirectory, ...(isDirectory(outDirectory) ? { outDirectory } : {}), user: options.user, network: net.args, secretNames: Object.keys(secrets) });
    const run = execa("docker", args, {
      input, timeout: timeoutMs, maxBuffer: 1024 * 1024, extendEnv: false, reject: false, ...(signal ? { cancelSignal: signal } : {}),
      env: { ...secrets, PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp", ...(process.env["DOCKER_HOST"] ? { DOCKER_HOST: process.env["DOCKER_HOST"] } : {}) },
    });
    // The proxy credentials are in a file the docker client reads when it starts: once the container exists the file has done its work.
    void whenCreated(name, run).then(net.started);
    const result = await run;
    // A run that was cut short (a timeout, or the runner that asked for it gone) leaves its container behind; it goes with the run.
    if (result.timedOut || result.exitCode === undefined || signal?.aborted) await execa("docker", ["rm", "-f", name], { timeout: 30_000, reject: false });
    return { status: 200, body: { exitCode: result.exitCode ?? -1, stdout: String(result.stdout).slice(0, 1024 * 1024), stderr: String(result.stderr).slice(0, 16_384), timedOut: result.timedOut === true } };
  } finally {
    net.started();
    net.release();
  }
}
