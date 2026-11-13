import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local company directory for tests: OpenID Connect discovery, an authorize endpoint that signs the chosen test user in without a
 * password page, a token endpoint that checks the client secret and the PKCE S256 verifier, signed ID tokens (RS256, nonce echoed),
 * a JWKS and a userinfo endpoint. It records what Brain sent so tests can assert PKCE and the secret were really used.
 */
export interface FakeUser { readonly sub: string; readonly email: string; readonly name: string; readonly groups?: readonly string[]; readonly emailVerified?: boolean; readonly omitEmailFromToken?: boolean }
export interface FakeOidc {
  readonly issuer: string;
  /** Who the next authorize request signs in. */
  loginAs(user: FakeUser): void;
  /** How many times Brain fetched the discovery document. */
  readonly discovery: { requests: number };
  readonly authorizeRequests: Array<Record<string, string>>;
  readonly tokenRequests: Array<{ params: Record<string, string>; basicAuth: string | null; pkceOk: boolean }>;
  close(): Promise<void>;
}

const b64 = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export async function startFakeOidc(config: { clientId: string; clientSecret: string }): Promise<FakeOidc> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { user: FakeUser; nonce: string; challenge: string; redirectUri: string }>();
  const tokens = new Map<string, FakeUser>();
  const authorizeRequests: Array<Record<string, string>> = [];
  const tokenRequests: FakeOidc["tokenRequests"] = [];
  const discovery = { requests: 0 };
  let current: FakeUser | undefined;
  let issuer = "";

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let data = ""; req.on("data", (chunk) => { data += chunk; }); req.on("end", () => resolve(data)); });
  const sign = (payload: Record<string, unknown>) => {
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fake-1" }));
    const body = b64(JSON.stringify(payload));
    const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64(signature)}`;
  };
  const claimsOf = (user: FakeUser) => ({ sub: user.sub, ...(user.omitEmailFromToken ? {} : { email: user.email }), email_verified: user.emailVerified ?? true, name: user.name, ...(user.groups ? { groups: user.groups } : {}) });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      discovery.requests++;
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = Object.fromEntries(url.searchParams);
      authorizeRequests.push(q);
      if (!current || q["client_id"] !== config.clientId || q["response_type"] !== "code" || !q["redirect_uri"] || !q["state"]) return json(400, { error: "invalid_request" });
      const code = randomBytes(12).toString("hex");
      codes.set(code, { user: current, nonce: q["nonce"] ?? "", challenge: q["code_challenge"] ?? "", redirectUri: q["redirect_uri"] });
      const back = new URL(q["redirect_uri"]);
      back.searchParams.set("code", code); back.searchParams.set("state", q["state"]);
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : null;
      const entry = codes.get(params["code"] ?? "");
      const verifier = params["code_verifier"] ?? "";
      const pkceOk = !!entry && b64(createHash("sha256").update(verifier).digest()) === entry.challenge;
      tokenRequests.push({ params, basicAuth: basic, pkceOk });
      const presentedSecret = basic ? decodeURIComponent(basic.split(":").slice(1).join(":")) : params["client_secret"];
      if (!entry || presentedSecret !== config.clientSecret || !pkceOk || params["redirect_uri"] !== entry.redirectUri) return json(400, { error: "invalid_grant" });
      codes.delete(params["code"]!);
      const accessToken = randomBytes(16).toString("hex");
      tokens.set(accessToken, entry.user);
      const now = Math.floor(Date.now() / 1000);
      return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: "openid email profile",
        id_token: sign({ iss: issuer, aud: config.clientId, iat: now, exp: now + 3600, nonce: entry.nonce, ...claimsOf(entry.user) }) });
    }
    if (url.pathname === "/userinfo") {
      const user = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /u, ""));
      if (!user) return json(401, { error: "invalid_token" });
      return json(200, { ...claimsOf({ ...user, omitEmailFromToken: false }) });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer, authorizeRequests, tokenRequests, discovery,
    loginAs(user) { current = user; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
