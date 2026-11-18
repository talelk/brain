import { connect as connectTcp, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { connect as connectTls } from "node:tls";
import { errorFields, log } from "../log";

/**
 * Mail is optional: Brain has none unless `BRAIN_SMTP_URL` is set (`smtp://user:password@host:587`, or `smtps://` for a connection that starts
 * encrypted). A plain `smtp://` must upgrade with STARTTLS: a server that does not offer it gets nothing, unless `BRAIN_SMTP_INSECURE=1` says
 * that a connection in the clear is wanted (a mail catcher on the same machine). `BRAIN_SMTP_FROM` is the sender. A link is also shown to the
 * admin who made it, so a failure here is logged without the message and never refuses the command. The server accepting a message is not the
 * message arriving: the result says only that the server accepted it.
 */
export const mailConfigured = (): boolean => Boolean(process.env["BRAIN_SMTP_URL"]);

/** Reads whole replies (`250 ok`, or `250-a` lines ending with `250 b`) from a socket. */
function replies(socket: Socket): () => Promise<string> {
  let buffer = "";
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  const feed = (socket_: Socket): void => {
    socket_.setEncoding("utf8");
    socket_.on("data", (chunk: string) => { buffer += chunk; wake?.(); });
    socket_.on("error", (e) => { failure = e; wake?.(); });
    socket_.on("close", () => { failure ??= new Error("closed"); wake?.(); });
  };
  feed(socket);
  return async () => {
    for (;;) {
      const lines = buffer.split("\r\n");
      const end = lines.findIndex((line) => /^\d{3} /u.test(line));
      if (end >= 0) { buffer = lines.slice(end + 1).join("\r\n"); return lines.slice(0, end + 1).join("\n"); }
      if (failure) throw failure;
      await new Promise<void>((done) => { wake = done; });
    }
  };
}

async function deliver(url: URL, from: string, to: string, subject: string, text: string): Promise<void> {
  const secure = url.protocol === "smtps:";
  const host = url.hostname;
  const port = Number(url.port) || (secure ? 465 : 587);
  let socket: Socket = secure ? connectTls({ host, port, servername: host }) : connectTcp({ host, port });
  socket.setTimeout(15_000, () => socket.destroy(new Error("timeout")));
  let read = replies(socket);
  const send = async (line: string, expect: string): Promise<string> => {
    socket.write(`${line}\r\n`);
    return expected(await read(), expect);
  };
  const expected = (reply: string, code: string): string => {
    if (!reply.startsWith(code)) throw new Error(`unexpected reply ${reply.slice(0, 3)}`);
    return reply;
  };
  try {
    expected(await read(), "220");
    let hello = await send("EHLO brain", "250");
    if (!secure) {
      if (/STARTTLS/iu.test(hello)) {
        await send("STARTTLS", "220");
        socket = connectTls({ socket, servername: host });
        read = replies(socket);
        hello = await send("EHLO brain", "250");
      } else if (process.env["BRAIN_SMTP_INSECURE"] !== "1") throw new Error("the server does not offer STARTTLS and BRAIN_SMTP_INSECURE is not set");
    }
    if (url.username) await send(`AUTH PLAIN ${Buffer.from(`\0${decodeURIComponent(url.username)}\0${decodeURIComponent(url.password)}`).toString("base64")}`, "235");
    await send(`MAIL FROM:<${from}>`, "250");
    await send(`RCPT TO:<${to}>`, "250");
    await send("DATA", "354");
    const body = text.replace(/\r?\n/gu, "\r\n").replace(/^\./gmu, "..");
    const headers = [`Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@${from.split("@")[1] ?? host}>`, `From: Brain <${from}>`, `To: <${to}>`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"];
    await send(`${headers.join("\r\n")}\r\n\r\n${body}\r\n.`, "250");
    await send("QUIT", "221").catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

/** Hands one plain-text message to the mail server; never throws. `accepted` is the server's word, not a delivery. */
export async function sendMail(to: string, subject: string, text: string): Promise<"accepted" | "failed"> {
  try {
    const url = new URL(process.env["BRAIN_SMTP_URL"] ?? "");
    await deliver(url, process.env["BRAIN_SMTP_FROM"] ?? `brain@${url.hostname}`, to, subject, text);
    log("info", "mail.accepted");
    return "accepted";
  } catch (e) {
    log("warn", "mail.failed", errorFields(e));
    return "failed";
  }
}
