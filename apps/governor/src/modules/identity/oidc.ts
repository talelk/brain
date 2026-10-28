import { existsSync, readFileSync, statSync } from "node:fs";

// External IdP (OIDC) configuration gate (T47). Federation is opt-in and
// all-or-nothing: a partial or insecure configuration fails startup instead
// of silently degrading to password-only or accepting a plaintext issuer.
// The client secret is read from a protected file reference, never from a
// plain environment value (docs/implementation/05).
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  const issuer = env["BRAIN_OIDC_ISSUER"];
  const clientId = env["BRAIN_OIDC_CLIENT_ID"];
  const secretFile = env["BRAIN_OIDC_CLIENT_SECRET_FILE"];
  if (!issuer && !clientId && !secretFile) return undefined;
  if (!issuer || !clientId || !secretFile) {
    throw new Error("OIDC configuration incomplete: BRAIN_OIDC_ISSUER, BRAIN_OIDC_CLIENT_ID and BRAIN_OIDC_CLIENT_SECRET_FILE are all required");
  }
  if (env["BRAIN_OIDC_CLIENT_SECRET"]) {
    throw new Error("BRAIN_OIDC_CLIENT_SECRET is refused: provide BRAIN_OIDC_CLIENT_SECRET_FILE so the secret stays a protected file");
  }
  let url: URL;
  try { url = new URL(issuer); } catch { throw new Error("BRAIN_OIDC_ISSUER must be an absolute URL"); }
  const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("BRAIN_OIDC_ISSUER must be https (http is allowed only for localhost development IdPs)");
  }
  if (!existsSync(secretFile)) throw new Error("BRAIN_OIDC_CLIENT_SECRET_FILE does not exist");
  const st = statSync(secretFile);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("BRAIN_OIDC_CLIENT_SECRET_FILE must be a regular file with no group/other permissions");
  const clientSecret = readFileSync(secretFile, "utf8").trim();
  if (clientSecret.length < 8) throw new Error("OIDC client secret file is empty or too short");
  const base = issuer.replace(/\/+$/u, "");
  return { issuer: base, clientId, clientSecret, discoveryUrl: `${base}/.well-known/openid-configuration` };
}
