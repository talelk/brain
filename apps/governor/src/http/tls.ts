import { existsSync, readFileSync, statSync } from "node:fs";

// Optional TLS serving (T06). All-or-nothing: a partial configuration fails
// startup instead of silently serving plaintext. Key material stays a
// protected file reference, matching the secret-handling rules elsewhere.
export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export function tlsMaterialFromEnv(env: NodeJS.ProcessEnv = process.env): TlsMaterial | undefined {
  const certFile = env["BRAIN_TLS_CERT_FILE"];
  const keyFile = env["BRAIN_TLS_KEY_FILE"];
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) throw new Error("TLS configuration incomplete: BRAIN_TLS_CERT_FILE and BRAIN_TLS_KEY_FILE are both required");
  for (const [label, path] of [["BRAIN_TLS_CERT_FILE", certFile], ["BRAIN_TLS_KEY_FILE", keyFile]] as const) {
    if (!existsSync(path)) throw new Error(`${label} does not exist`);
  }
  const keyStat = statSync(keyFile);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
    throw new Error("BRAIN_TLS_KEY_FILE must be a regular file with no group/other permissions");
  }
  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);
  if (!cert.includes("BEGIN CERTIFICATE")) throw new Error("BRAIN_TLS_CERT_FILE is not a PEM certificate");
  if (!key.includes("PRIVATE KEY-----")) throw new Error("BRAIN_TLS_KEY_FILE is not a PEM private key");
  return { cert, key };
}
