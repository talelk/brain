import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A minimal SMTP submission client (RFC 5321) for the optional email channel (ADR 0011 amendment). It speaks EHLO, STARTTLS, AUTH PLAIN
 * or LOGIN, MAIL FROM, RCPT TO and DATA over `node:net` / `node:tls`, one message per connection. No dependency was added for it.
 * Credentials are only sent over an encrypted connection, except to this machine.
 */
export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
  /** smtps: the connection is TLS from the first byte. */
  readonly implicitTls: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  /** Test seam: trust this CA (PEM) for the server certificate. Never set from configuration. */
  readonly ca?: string;
}

export interface MailMessage { readonly to: string; readonly subject: string; readonly text: string }

/** `smtp(s)://user:pass@host:port` plus the sender address; undefined when either is missing or malformed. */
export function smtpTarget(env: NodeJS.ProcessEnv = process.env): SmtpTarget | undefined {
  const raw = env["BRAIN_NOTIFY_SMTP_URL"];
  const from = env["BRAIN_NOTIFY_FROM"]?.trim();
  if (!raw || !from || !validAddress(from)) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return undefined;
  if (!url.hostname) return undefined;
  const implicitTls = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : implicitTls ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const user = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  return { host: url.hostname.replace(/^\[|\]$/gu, ""), port, implicitTls, from, ...(user ? { user } : {}), ...(password ? { password } : {}) };
}

/** A conservative address check; it also keeps line breaks out of SMTP commands and headers. */
export function validAddress(address: string): boolean {
  return /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+\.[^\s<>()[\]\\,;:"@]+$/u.test(address) && address.length <= 254;
}

const isLocal = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "::1";
const isLocalOrIp = (host: string): boolean => isLocal(host) || /^[\d.]+$/u.test(host) || host.includes(":");

interface Reply { code: number; text: string }

/** Reads CRLF-delimited SMTP replies (multi-line replies end at the line with a space after the code) from a socket that can be swapped for its TLS upgrade. */
class Wire {
  socket: Socket | TLSSocket;
  private buffer = "";
  private partial: string[] = [];
  private ready: Reply[] = [];
  private waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;
  constructor(socket: Socket | TLSSocket) { this.socket = socket; this.attach(socket); }
  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { this.buffer += chunk; this.drain(); });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("connection closed")));
  }
  /** Replaces the socket after STARTTLS. Anything buffered from before the upgrade is discarded: it came over plaintext. */
  swap(socket: TLSSocket): void { this.buffer = ""; this.partial = []; this.ready = []; this.socket = socket; this.attach(socket); }
  private fail(error: Error): void { this.failure ??= error; const waiting = this.waiting; this.waiting = undefined; waiting?.reject(error); }
  private drain(): void {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.partial.push(line);
      if (/^\d{3}( |$)/u.test(line)) {
        const reply: Reply = { code: Number(line.slice(0, 3)), text: this.partial.map((l) => l.slice(4)).join("\n") };
        this.partial = [];
        const waiting = this.waiting;
        if (waiting) { this.waiting = undefined; waiting.resolve(reply); } else this.ready.push(reply);
      } else if (!/^\d{3}-/u.test(line)) { this.partial = []; }
    }
  }
  next(): Promise<Reply> {
    const ready = this.ready.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  write(text: string): void { this.socket.write(text); }
}

async function step(wire: Wire, send: string | undefined, ok: readonly number[], what: string): Promise<Reply> {
  if (send !== undefined) wire.write(`${send}\r\n`);
  const reply = await wire.next();
  if (!ok.includes(reply.code)) throw new Error(`${what} refused: ${reply.code} ${reply.text.split("\n").pop()?.slice(0, 120) ?? ""}`.trim());
  return reply;
}

/** Header values may not carry line breaks; non-ASCII is encoded (RFC 2047). */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/gu, " ").trim();
  return /^[\x20-\x7e]*$/u.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** The message as sent in DATA (dot-stuffed, CRLF), without the final terminator line. */
export function composeMessage(target: SmtpTarget, message: MailMessage, messageId: string, date = new Date()): string {
  const domain = target.from.split("@")[1] ?? "brain.invalid";
  const body = message.text.replace(/\r?\n/gu, "\r\n").split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
  return [
    `From: ${target.from}`, `To: ${message.to}`, `Subject: ${headerValue(message.subject)}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}@${domain}>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "Auto-Submitted: auto-generated", "", body, "",
  ].join("\r\n");
}

/** Sends one message. Resolves when the server accepted it; rejects with a short plain reason (never the credentials). */
export async function sendMail(target: SmtpTarget, message: MailMessage, options: { timeoutMs?: number } = {}): Promise<void> {
  if (!validAddress(message.to)) throw new Error("the recipient address is not valid");
  const servername = isLocalOrIp(target.host) ? undefined : target.host;
  const tlsOptions = { ...(servername ? { servername } : {}), ...(target.ca ? { ca: target.ca } : {}) };
  const socket: Socket | TLSSocket = target.implicitTls ? tlsConnect({ host: target.host, port: target.port, ...tlsOptions }) : netConnect({ host: target.host, port: target.port });
  const wire = new Wire(socket);
  const timer = setTimeout(() => socket.destroy(new Error("timed out")), options.timeoutMs ?? 15_000);
  try {
    await step(wire, undefined, [220], "greeting");
    let encrypted = target.implicitTls;
    let capabilities = (await step(wire, "EHLO brain.local", [250], "EHLO")).text.toUpperCase().split("\n");
    if (!encrypted && capabilities.includes("STARTTLS")) {
      await step(wire, "STARTTLS", [220], "STARTTLS");
      wire.socket.removeAllListeners("data");
      const upgraded = tlsConnect({ socket: wire.socket as Socket, ...tlsOptions });
      await new Promise<void>((resolve, reject) => { upgraded.once("secureConnect", () => resolve()); upgraded.once("error", reject); });
      wire.swap(upgraded);
      encrypted = true;
      capabilities = (await step(wire, "EHLO brain.local", [250], "EHLO")).text.toUpperCase().split("\n");
    }
    if (target.user !== undefined && target.password !== undefined) {
      if (!encrypted && !isLocal(target.host)) throw new Error("refusing to send credentials without encryption");
      const methods = capabilities.filter((line) => line.startsWith("AUTH")).flatMap((line) => line.split(/[\s=]+/u).slice(1));
      if (methods.includes("PLAIN")) {
        await step(wire, `AUTH PLAIN ${Buffer.from(`\0${target.user}\0${target.password}`, "utf8").toString("base64")}`, [235], "authentication");
      } else if (methods.includes("LOGIN")) {
        await step(wire, "AUTH LOGIN", [334], "authentication");
        await step(wire, Buffer.from(target.user, "utf8").toString("base64"), [334], "authentication");
        await step(wire, Buffer.from(target.password, "utf8").toString("base64"), [235], "authentication");
      } else throw new Error("the server offers no supported login method");
    }
    await step(wire, `MAIL FROM:<${target.from}>`, [250], "sender");
    await step(wire, `RCPT TO:<${message.to}>`, [250, 251], "recipient");
    await step(wire, "DATA", [354], "DATA");
    wire.write(`${composeMessage(target, message, `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`)}.\r\n`);
    await step(wire, undefined, [250], "message");
    wire.write("QUIT\r\n");
  } finally {
    clearTimeout(timer);
    wire.socket.destroy();
  }
}
