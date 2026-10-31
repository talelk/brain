import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { acquireDirectory } from "../apps/governor/src/infrastructure/persistence/directory";

export interface LocalInstance { root: string; data: string; run: string; cli: string }
export function instancePaths(env: NodeJS.ProcessEnv): LocalInstance {
  const root = resolve(env["BRAIN_INSTANCE_DIR"] ?? join(homedir(), ".local", "share", "brain"));
  return { root, data: resolve(env["BRAIN_DATA_DIR"] ?? join(root, "data")), run: resolve(env["BRAIN_RUN_DIR"] ?? join(root, "run")), cli: resolve(env["BRAIN_CLI_STATE_DIR"] ?? join(root, "cli")) };
}
function check(paths: LocalInstance): void {
  const checkoutRelative = relative(process.cwd(), paths.root);
  if (!checkoutRelative.startsWith("..") && !isAbsolute(checkoutRelative)) throw new Error("A resettable local instance must be outside the checkout");
  if (["/", homedir(), process.cwd()].includes(paths.root)) throw new Error("The instance root cannot be a filesystem, home or checkout root");
  for (const target of [paths.data, paths.run, paths.cli]) {
    const rel = relative(paths.root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Reset requires every managed directory to be inside BRAIN_INSTANCE_DIR");
    let current = target;
    while (current !== dirname(current)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Managed instance paths cannot contain symbolic links");
      current = dirname(current);
    }
  }
  const targets = [paths.data, paths.run, paths.cli];
  if (new Set(targets).size !== targets.length || targets.some((a) => targets.some((b) => a !== b && b.startsWith(a + "/")))) throw new Error("Managed directories must be distinct and cannot contain each other");
}
export function registerInstance(paths: LocalInstance): void {
  check(paths); mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const marker = join(paths.root, ".brain-instance.json");
  if (!existsSync(marker) && existsSync(paths.data) && readdirSync(paths.data).length && !existsSync(join(paths.data, "control.db"))) throw new Error("Refusing to register an existing directory that is not Brain data");
  if (existsSync(marker)) { verifyInstance(paths); return; }
  writeFileSync(marker, JSON.stringify({ format: "brain.local-instance/v1", ...paths }), { mode: 0o600, flag: "wx" });
}
export function verifyInstance(paths: LocalInstance): void {
  check(paths);
  const marker = join(paths.root, ".brain-instance.json");
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error("An owned regular Brain instance marker is required");
  const saved = JSON.parse(readFileSync(marker, "utf8")) as Record<string, string>;
  if (saved["format"] !== "brain.local-instance/v1" || Object.entries(paths).some(([key, value]) => saved[key] !== value)) throw new Error("Instance paths do not match the managed instance marker");
  if (realpathSync(paths.root) !== paths.root) throw new Error("Instance root must be a real path");
}
/** Caller must stop the owned processes first. An active Governor still holds its kernel lock. */
export function resetInstance(paths: LocalInstance): void {
  verifyInstance(paths);
  if (existsSync(paths.run) && readdirSync(paths.run).some((name) => name.endsWith(".pid"))) throw new Error("Owned processes could not all be stopped; reset refused");
  const release = existsSync(paths.data) ? acquireDirectory(paths.data) : () => {};
  try {
    for (const directory of [paths.data, paths.run, paths.cli]) rmSync(directory, { recursive: true, force: true });
  } finally { release(); }
}
