import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createSecureContext } from "node:tls";

/** An in-process SMTP server for tests: records messages and the AUTH it saw; can refuse RCPT, refuse AUTH, or stall. */
export interface FakeSmtpOptions {
  readonly starttls?: boolean;
  /** smtps: the whole connection is TLS. */
  readonly implicitTls?: boolean;
  readonly auth?: "plain" | "login" | "both";
  readonly user?: string;
  readonly password?: string;
  /** Reply to RCPT TO with this line instead of 250 (for example "550 mailbox unavailable"). */
  readonly rcptReply?: string;
  readonly stall?: boolean;
}

export interface FakeSmtp {
  readonly port: number;
  readonly ca: string;
  readonly messages: Array<{ from: string; to: string; data: string; encrypted: boolean; authenticated: boolean }>;
  readonly commands: string[];
  readonly connections: () => number;
  close(): Promise<void>;
}

export function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const tls = options.starttls || options.implicitTls ? selfSignedCert() : undefined;
  const messages: FakeSmtp["messages"] = [];
  const commands: string[] = [];
  let connections = 0;
  const handle = (initial: Socket, encrypted: boolean): void => {
    connections += 1;
    let socket: Socket = initial;
    let secure = encrypted;
    let authed = false;
    let from = "";
    let to = "";
    let data: string[] | undefined;
    let loginStep: "user" | "pass" | undefined;
    let buffer = "";
    const send = (line: string): void => { socket.write(`${line}\r\n`); };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") { messages.push({ from, to, data: data.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n"), encrypted: secure, authenticated: authed }); data = undefined; send("250 queued"); } else data.push(line);
          continue;
        }
        if (loginStep) {
          commands.push(loginStep === "user" ? "<login user>" : "<login password>");
          if (loginStep === "user") { loginStep = "pass"; send("334 UGFzc3dvcmQ6"); } else {
            loginStep = undefined;
            authed = Buffer.from(line, "base64").toString("utf8") === options.password;
            send(authed ? "235 ok" : "535 authentication failed");
          }
          continue;
        }
        const upper = line.toUpperCase();
        // Credentials never enter the recorded command log.
        commands.push(upper.startsWith("AUTH PLAIN") ? "AUTH PLAIN <redacted>" : line);
        if (upper.startsWith("EHLO")) {
          const lines = ["250-fake.test"];
          if (options.starttls && !secure) lines.push("250-STARTTLS");
          if (options.auth) lines.push(`250-AUTH ${options.auth === "plain" ? "PLAIN" : options.auth === "login" ? "LOGIN" : "PLAIN LOGIN"}`);
          lines.push("250 8BITMIME");
          socket.write(`${lines.join("\r\n")}\r\n`);
        } else if (upper === "STARTTLS") {
          send("220 ready");
          const secured = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key: tls!.key, cert: tls!.cert }) });
          socket.removeListener("data", onData);
          secured.on("data", onData);
          secured.on("error", () => undefined);
          socket = secured;
          secure = true;
          buffer = "";
          return;
        } else if (upper.startsWith("AUTH PLAIN")) {
          const [, user, password] = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").split("\0");
          authed = user === options.user && password === options.password;
          send(authed ? "235 ok" : "535 authentication failed");
        } else if (upper === "AUTH LOGIN") { loginStep = "user"; send("334 VXNlcm5hbWU6"); }
        else if (upper.startsWith("MAIL FROM:")) { from = line.slice(10).replace(/[<>]/gu, ""); send("250 ok"); }
        else if (upper.startsWith("RCPT TO:")) { to = line.slice(8).replace(/[<>]/gu, ""); send(options.rcptReply ?? "250 ok"); }
        else if (upper === "DATA") { data = []; send("354 go ahead"); }
        else if (upper === "QUIT") { send("221 bye"); socket.end(); }
        else send("502 not implemented");
      }
    };
    socket.on("data", onData);
    socket.on("error", () => undefined);
    if (!options.stall) send("220 fake.test ESMTP");
  };
  const server: Server = options.implicitTls
    ? (await import("node:tls")).createServer({ key: tls!.key, cert: tls!.cert }, (socket) => handle(socket, true)) as unknown as Server
    : createServer((socket) => handle(socket, false));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, ca: tls?.cert ?? "", messages, commands, connections: () => connections, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); }) };
}
