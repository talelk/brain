import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execa } from "execa";
import { isAttemptId } from "@brain/contracts";
import { isEgressHost, removeEgressGrant, writeEgressGrant } from "./egress-proxy";

/**
 * What every sandbox of the launcher shares. A request names an attempt, never a host path: the launcher finds the attempt's folders
 * under the operator's root (BRAIN_LAUNCHER_ATTEMPTS_ROOT, the runner's `<state>/attempts`) and mounts only those. A sandbox's root is
 * read-only, it has no capabilities, it cannot gain privileges, its cpu, memory and process count are bounded, and its only network is
 * the egress proxy with a grant for the hosts the request names.
 */
export type Reply = { status: number; body: Record<string, unknown> };
export const refuse = (status: number, error: string): Reply => ({ status, body: { error } });
export const slug = (text: string): string => text.replace(/[^A-Za-z0-9_.-]/gu, "-").replace(/^[^A-Za-z0-9]+/u, "").slice(0, 80);

export interface SandboxOptions {
  /** `BRAIN_LAUNCHER_ATTEMPTS_ROOT`: the host directory that holds every attempt's folder. */
  readonly attemptsRoot: string | undefined;
  readonly egressGrantsDir: string | undefined;
  /** `uid:gid` a sandbox runs as: the owner of the attempt folders. */
  readonly user: string;
  /** The reason an image may not run (a pin that does not match), or undefined. */
  readonly verifyImage: (image: string) => Promise<string | undefined>;
}

/** The hardening of every sandbox, with its limits. */
export function hardening(cpuMillicores: number, memoryMb: number, pids: number, user: string, tmpMb: number): string[] {
  return ["--read-only", "--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--cpus", String(Math.max(0.1, cpuMillicores / 1000)), "--memory", `${memoryMb}m`, "--memory-swap", `${memoryMb}m`, "--pids-limit", String(pids),
    "--user", user, "--tmpfs", `/tmp:rw,nosuid,nodev,size=${tmpMb}m`];
}

/** The attempt's folder under the operator's root, or why it cannot be used. A name that leaves the root, or a link, never mounts. */
export function attemptFolder(root: string | undefined, attemptId: string): { ok: true; directory: string } | { ok: false; reply: Reply } {
  if (!root) return { ok: false, reply: refuse(409, "sandboxes are not configured on this launcher (BRAIN_LAUNCHER_ATTEMPTS_ROOT)") };
  if (!isAttemptId(attemptId)) return { ok: false, reply: refuse(422, "attemptId invalid") };
  const directory = resolve(root, attemptId);
  if (!directory.startsWith(resolve(root) + sep)) return { ok: false, reply: refuse(422, "attemptId invalid") };
  return isDirectory(directory) ? { ok: true, directory } : { ok: false, reply: refuse(409, "the attempt's folder is absent on this host") };
}

export function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** The hosts of a request, or why they are refused. */
export function egressHosts(value: unknown, grantsDir: string | undefined): { ok: true; hosts: string[] } | { ok: false; reply: Reply } {
  const hosts = Array.isArray(value) ? value.map((host) => String(host)) : [];
  if (hosts.length > 100 || hosts.some((host) => !isEgressHost(host))) return { ok: false, reply: refuse(422, "egressHosts must be at most 100 lower-case host or host:port entries") };
  if (hosts.length > 0 && !grantsDir) return { ok: false, reply: refuse(409, "the egress proxy is not configured on this launcher (BRAIN_LAUNCHER_EGRESS_GRANTS_DIR)") };
  return { ok: true, hosts };
}

export interface Network { readonly args: string[]; readonly grantId: string | undefined; release(): void; started(): void }

/**
 * The network of one sandbox: none without hosts; otherwise the internal network and a grant at the proxy for exactly these hosts. The
 * proxy credentials reach the container through a 0600 file that exists only until the container has started, so they are never in an
 * argv, where `ps` and `docker inspect` would show them. `release` drops the grant; `started` removes the file.
 */
export async function network(hosts: readonly string[], grantsDir: string | undefined): Promise<Network> {
  if (hosts.length === 0 || !grantsDir) return { args: ["--network", "none"], grantId: undefined, release: () => undefined, started: () => undefined };
  await execa("docker", ["network", "create", "--internal", "brain-internal"], { timeout: 15_000, reject: false });
  const grant = writeEgressGrant(grantsDir, hosts);
  const envDir = mkdtempSync(join(tmpdir(), "brain-sandbox-env-"));
  const envFile = join(envDir, "proxy.env");
  const proxyUrl = `http://${grant.id}:${grant.token}@brain-egress-proxy:18080`;
  writeFileSync(envFile, ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"].map((name) => `${name}=${proxyUrl}\n`).join(""), { mode: 0o600 });
  return {
    args: ["--network", "brain-internal", "--env-file", envFile, "-e", "no_proxy=127.0.0.1,localhost", "-e", "NODE_USE_ENV_PROXY=1", "--label", `brain.egress-grant=${grant.id}`],
    grantId: grant.id,
    release: () => removeEgressGrant(grantsDir, grant.id),
    started: () => rmSync(envDir, { recursive: true, force: true }),
  };
}

/** Resolves once the container `name` exists (the docker client has then read everything it was given), or when `running` has ended, or after ten seconds. */
export async function whenCreated(name: string, running: PromiseLike<unknown>): Promise<void> {
  let ended = false;
  void Promise.resolve(running).then(() => { ended = true; }, () => { ended = true; });
  for (let waited = 0; waited < 10_000 && !ended; waited += 100) {
    if ((await execa("docker", ["inspect", "--format", "{{.Id}}", name], { timeout: 5000, reject: false })).exitCode === 0) return;
    await new Promise((resume) => { setTimeout(resume, 100); });
  }
}

/** After a launcher restart no sandbox can be reattached (its stdin was the launcher's): containers with this label are removed. */
export async function removeLeftovers(label: string): Promise<void> {
  try {
    const listed = await execa("docker", ["ps", "-aq", "--filter", `label=${label}`], { timeout: 15_000, reject: false });
    const ids = listed.exitCode === 0 ? String(listed.stdout).split("\n").map((id) => id.trim()).filter(Boolean) : [];
    if (ids.length > 0) await execa("docker", ["rm", "-f", ...ids], { timeout: 60_000, reject: false });
  } catch { /* docker unreachable: nothing to remove, and none can start */ }
}
