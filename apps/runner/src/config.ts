import { hostname } from "node:os";
import { join } from "node:path";
import { type Launcher, LauncherClient } from "./launcher-client";
import type { ApprovalWait } from "./tools/approval";

/** Everything a runner is configured with. `main.ts` reads it from the environment (`configFromEnv`); tests build it by hand. */
export interface RunnerConfig {
  readonly governorUrl: string;
  /** The runner's folder (docs/architecture.md section 8): its key and credential, cached blobs, repository mirrors and attempt folders. */
  readonly stateDir: string;
  /** The name this runner enrols under. */
  readonly name: string;
  /** The one-use enrolment token; needed only until the runner holds a credential. */
  readonly enrollToken?: string;
  /** The plain capability names the operator declares (`bash`, `python3`, `curl`, `docker`). `native-tools` is never declared: the runner states it itself. */
  readonly capabilities: readonly string[];
  readonly engines: readonly string[];
  /** Engines the fixture stands in for, so that agents written for them run with no model. Only where `engines` has `fixture`. */
  readonly fixtureFor?: readonly string[];
  readonly slots: number;
  /** How long one engine session may run; the offer carries no time limit. */
  readonly attemptTimeoutMs: number;
  /** What an engine sandbox may use; the offer carries no reservation. */
  readonly sandbox: { readonly cpuMillicores: number; readonly memoryMb: number };
  /** The trusted launcher. Without one, Pi and Claude run in the runner with their own tools off, an ACP agent does not run, and no tool script or host command runs. */
  readonly launcher?: Launcher;
  /** Transport seam for the Governor client; tests hand in a Governor that runs in the same process. */
  readonly transport?: typeof fetch;
  /** The clock and length of the approval wait; tests shorten it or move the clock by hand. */
  readonly approval?: ApprovalWait;
  /** TEST ONLY: with no launcher, run tool scripts and project setup commands directly on this host. `configFromEnv` never sets it. */
  readonly unsandboxedForTests?: boolean;
}

/** The runner's configuration from its environment; the variables are listed in docs/environment.md (packages/contracts/src/env.ts). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const list = (name: string, fallback: string): string[] => (env[name] ?? fallback).split(",").map((entry) => entry.trim()).filter(Boolean);
  const positive = (name: string, fallback: number): number => { const value = Number(env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; };
  const socket = env["BRAIN_LAUNCHER_SOCKET"];
  return {
    governorUrl: env["BRAIN_GOVERNOR_URL"] ?? "http://127.0.0.1:3100",
    stateDir: env["BRAIN_RUNNER_STATE_DIR"] ?? join(process.cwd(), ".runner-state"),
    name: env["BRAIN_RUNNER_NAME"] ?? hostname(),
    ...(env["BRAIN_RUNNER_ENROLL_TOKEN"] ? { enrollToken: env["BRAIN_RUNNER_ENROLL_TOKEN"] } : {}),
    capabilities: list("BRAIN_RUNNER_CAPABILITIES", "bash"),
    engines: list("BRAIN_RUNNER_ENGINES", "fixture"),
    ...(env["BRAIN_RUNNER_FIXTURE_FOR"] ? { fixtureFor: list("BRAIN_RUNNER_FIXTURE_FOR", "") } : {}),
    slots: positive("BRAIN_RUNNER_SLOTS", 1),
    attemptTimeoutMs: positive("BRAIN_RUNNER_ATTEMPT_TIMEOUT_SECONDS", 3600) * 1000,
    sandbox: { cpuMillicores: positive("BRAIN_RUNNER_SANDBOX_CPU_MILLICORES", 2000), memoryMb: positive("BRAIN_RUNNER_SANDBOX_MEMORY_MB", 4096) },
    ...(socket ? { launcher: new LauncherClient(socket, env) } : {}),
  };
}
