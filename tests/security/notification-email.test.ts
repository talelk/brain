import { afterEach, describe, expect, it } from "vitest";
import { composeMessage, emailContent, safeMailLink, sendEmail, smtpTarget, validAddress } from "../../apps/governor/src/modules/operations/index";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp";
import { setupWorld } from "../helpers";

const keys = ["BRAIN_NOTIFY_SMTP_URL", "BRAIN_NOTIFY_FROM", "BRAIN_BASE_URL"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const servers: FakeSmtp[] = [];
const worlds: Array<ReturnType<typeof setupWorld>> = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) w.brain.close();
  for (const s of servers.splice(0)) await s.close();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

describe("email never carries a secret, a typed title or a credential-bearing link", () => {
  it("mail links keep only path and known ids; token, key and secret parameters, fragments and userinfo are dropped", () => {
    const link = safeMailLink("/missions/m1/outputs?w=ws-1&result=r1&token=SECRET123&key=abc&sig=zzz&session=s#access_token=SECRET456", "https://brain.example.test");
    expect(link).toBe("https://brain.example.test/missions/m1/outputs?w=ws-1&result=r1");
    expect(safeMailLink("/live?w=ws%0d%0aBcc:evil@example.test", "https://brain.example.test")).toBe("https://brain.example.test/live");
    // Even a hostile absolute URL is resolved against this server, never followed elsewhere.
    expect(safeMailLink("https://evil.example.test/steal?token=x", "https://brain.example.test")).toMatch(/^https:\/\/brain\.example\.test\/steal$/u);
  });

  it("the body is a generic sentence and a link for every kind", () => {
    for (const kind of ["digest", "result-ready", "approval", "needs-attention", "parked"]) {
      const { subject, text } = emailContent({ kind, link: "https://brain.example.test/w/ws/today", count: 3 });
      expect(`${subject}\n${text}`).not.toMatch(/token|secret|password|sha256:|bearer/iu);
      expect(text.split("\n").filter((line) => /https?:\/\//u.test(line))).toHaveLength(1);
    }
  });

  it("an address cannot carry a header or command injection", () => {
    expect(validAddress("a@example.test")).toBe(true);
    for (const bad of ["a@example.test\r\nBcc: x@example.test", "a b@example.test", "<a@example.test>", "a@example.test,b@example.test", "a@@example.test"]) expect(validAddress(bad)).toBe(false);
    const message = composeMessage({ host: "h", port: 1, implicitTls: false, from: "brain@example.test" }, { to: "p@example.test", subject: "Hi\r\nBcc: evil@example.test", text: "x" }, "id");
    expect(message.split("\r\n").filter((line) => /^Bcc:/iu.test(line))).toEqual([]);
  });

  it("the SMTP password never reaches the mail, the recorded reasons or the preferences view", async () => {
    const smtp = await startFakeSmtp({ auth: "plain", user: "mailer", password: "Tr0ub4dor&3-secret" }); servers.push(smtp);
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://mailer:${encodeURIComponent("Tr0ub4dor&3-secret")}@127.0.0.1:${smtp.port}`;
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
    const w = setupWorld(); worlds.push(w);
    w.brain.setNotificationPreferences(w.owner, { email: true });
    expect(await sendEmail(w.brain.store, w.org, "owner-1", { kind: "approval", url: "/approvals?token=LEAK&w=ws-test" })).toBe(true);
    expect(smtp.messages[0]!.data).not.toMatch(/Tr0ub4dor|LEAK|token/u);
    expect(smtp.messages[0]!.data).toContain("https://brain.example.test/approvals?w=ws-test");
    // A wrong password: the recorded reason is the server's answer, never the password.
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://mailer:wrong-Tr0ub4dor@127.0.0.1:${smtp.port}`;
    expect(await sendEmail(w.brain.store, w.org, "owner-1", { kind: "approval", url: "/approvals" })).toBe(false);
    const view = JSON.stringify(w.brain.notificationPreferences(w.owner));
    expect(view).toMatch(/authentication refused: 535/u);
    expect(view).not.toMatch(/Tr0ub4dor|mailer/u);
    expect(smtpTarget()?.password).toBe("wrong-Tr0ub4dor");
  });

  it("the server-wide address list is never exposed: another person's address is not in the view", async () => {
    const smtp = await startFakeSmtp(); servers.push(smtp);
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${smtp.port}`;
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    const w = setupWorld(); worlds.push(w);
    w.brain.setNotificationPreferences(w.owner, { email: true });
    await sendEmail(w.brain.store, w.org, "owner-1", { kind: "result-ready", url: "/x" });
    expect(JSON.stringify(w.brain.notificationPreferences(w.owner))).not.toContain("fixture.test");
  });
});
