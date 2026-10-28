import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Vendor session serialization is opaque. Bound printable header bytes without
// guessing whether its signature uses base64, base64url or percent encoding.
export const validCredential = (token: string) => /^[\x21-\x7e]{32,1024}$/u.test(token);

export function credentialStore(origin: string, env: NodeJS.ProcessEnv) {
  const directory = env["BRAIN_CLI_STATE_DIR"] ?? join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "brain");
  const path = join(directory, `${createHash("sha256").update(origin).digest("hex")}.json`);
  function privatePath(file: string, directory = false) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("CLI credentials require an owned private file and directory");
  }
  return {
    read(): string {
      if (!existsSync(path)) return "";
      privatePath(directory, true); privatePath(path);
      if (lstatSync(path).size > 4096) throw new Error("invalid CLI credential record");
      let record: Record<string, unknown>;
      try { record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
      catch { throw new Error("invalid CLI credential record"); }
      if (!record || typeof record !== "object" || record["format"] !== "brain.cli-credential/v1" || record["origin"] !== origin || typeof record["token"] !== "string" || !validCredential(record["token"]) || Object.keys(record).length !== 3) throw new Error("invalid CLI credential record");
      return record["token"];
    },
    save(token: string) {
      if (!validCredential(token)) throw new Error("invalid CLI credential format");
      mkdirSync(directory, { recursive: true, mode: 0o700 }); privatePath(directory, true);
      if (existsSync(path)) privatePath(path);
      const temporary = join(directory, `.credential-${randomBytes(16).toString("hex")}`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { writeFileSync(fd, JSON.stringify({ format: "brain.cli-credential/v1", origin, token })); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(temporary, path);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    },
    clear() { if (existsSync(path)) { privatePath(directory, true); privatePath(path); unlinkSync(path); } },
  };
}

export function readSetupCredential(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 512) throw new Error("setup credential must be a private regular file");
  const value = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("invalid setup credential format");
  return value;
}
