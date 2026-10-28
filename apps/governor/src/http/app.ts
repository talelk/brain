import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ZodError } from "zod";
import { validate } from "@brain/contracts/validate";
import type { ActorContext, HumanApprovalDecision, IdentityView, RunnerVerdictRequest } from "@brain/contracts";
import { Brain } from "../application/brain";
import { scopesForPrincipal } from "../application/authz";
import { BrainDomainError, brainError, statusForCode } from "../domain/errors";
import { newId } from "../domain/clock";
import type { GovernorHandle } from "../container";

import { BodyReader, parseJson } from "./body";
import { tlsMaterialFromEnv } from "./tls";
const MAX_JSON = 256 * 1024;

function correlation(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-correlation-id") ?? newId("corr");
}

export async function createApp(opts?: { dataDir?: string; allowTestActor?: boolean }): Promise<GovernorHandle & { brain: Brain }> {
  const dataDir = opts?.dataDir ?? process.env["BRAIN_DATA_DIR"] ?? join(process.cwd(), ".brain-data");
  const publicOrigin = process.env["BRAIN_BASE_URL"] ? new URL(process.env["BRAIN_BASE_URL"]).origin : undefined;
  const allowTestActor = opts?.allowTestActor ?? process.env["BRAIN_ALLOW_TEST_ACTOR"] === "1";
  if (allowTestActor && process.env["NODE_ENV"] === "production") throw new Error("test actor refused in production");
  const brain = new Brain({ dataDir, allowTestActor });
  await brain.auth.ready();
  const app = new Hono();
  const bodies = new BodyReader();
  const readJson = async (c: { req: { raw: Request } }) => parseJson(await bodies.read(c.req.raw, MAX_JSON));
  const requireBody = (name: string, body: unknown) => {
    const result = validate(name, body);
    if (!result.ok) throw new BrainDomainError("INVALID_CONTRACT", result.errors.join("; "));
  };

  const fail = (c: never, e: unknown) => {
    const ctx = c as unknown as { req: { header: (n: string) => string | undefined }; json: (b: unknown, s?: number) => Response };
    const corr = correlation(ctx);
    if (e instanceof ZodError) return ctx.json(brainError("INVALID_CONTRACT", "request does not match the current contract", corr), 400);
    if (e instanceof BrainDomainError) return ctx.json(e.toBrainError(corr), statusForCode(e.code));
    return ctx.json(brainError("INTERNAL_ERROR", "internal operation failed", corr), 500);
  };
  app.onError((error, c) => fail(c as never,error));

  const actorFor = (c: { req: { raw: Request } }, workspaceId?: string) => brain.resolveActor(c.req.raw.headers, workspaceId);

  // E005: cookie-authenticated mutations must be same-origin. Bearer-token
  // requests are not ambient credentials and are exempt.
  app.use("/v1/*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      const headers = c.req.raw.headers;
      const hasBearer = (headers.get("authorization") ?? "").startsWith("Bearer ");
      const hasCookie = !!headers.get("cookie");
      if (!hasBearer && hasCookie) {
        const origin = headers.get("origin");
        const fetchSite = headers.get("sec-fetch-site");
        let sameOrigin = fetchSite === "same-origin" || fetchSite === "none";
        if (origin) {
          try { sameOrigin = new URL(origin).origin === (publicOrigin ?? new URL(c.req.url).origin); } catch { sameOrigin = false; }
        } else if (!fetchSite) {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          return c.json(brainError("FORBIDDEN", "cross-origin cookie mutation rejected", correlation(c)), 403);
        }
      }
    }
    return next();
  });
  app.use("/runner/*", async (c,next) => {
    if (c.req.raw.headers.has("cookie")) return c.json(brainError("UNAUTHENTICATED","browser cookies rejected on runner endpoints",correlation(c)),401);
    return next();
  });

  // Better Auth credential plane (users, sessions, organizations, TOTP enrollment).
  app.get("/api/auth/*", (c) => {
    const cb = new URL(c.req.url).searchParams.get("callbackURL");
    if (cb) {
      const allowed = new Set([new URL(c.req.url).origin, `http://${c.req.header("host")}`, `https://${c.req.header("host")}`, ...(publicOrigin ? [publicOrigin] : [])]);
      let cbOrigin: string | null = null;
      try { cbOrigin = new URL(cb).origin; } catch { cbOrigin = null; }
      if (cbOrigin && cbOrigin !== "null" && !allowed.has(cbOrigin)) {
        return c.json(brainError("FORBIDDEN", "foreign callbackURL refused", correlation(c as never)), 403);
      }
    }
    return brain.auth.handler(c.req.raw);
  });
  app.post("/api/auth/*", async (c) => {
    // Exact-origin guard for cookie-authenticated auth mutations (T47): the
    // vendor origin check does not cover every credential endpoint, so a
    // foreign Origin on a cookie-carrying POST is refused before the vendor
    // handler runs. Bearer-only clients (no cookie) are unaffected.
    const origin = c.req.header("origin");
    const cookie = c.req.header("cookie");
    if (origin && cookie) {
      const allowed = new Set([new URL(c.req.url).origin, `http://${c.req.header("host")}`, `https://${c.req.header("host")}`, ...(publicOrigin ? [publicOrigin] : [])]);
      if (!allowed.has(origin)) return c.json(brainError("FORBIDDEN", "cross-origin auth mutation refused", correlation(c as never)), 403);
    }
    const bytes=await bodies.read(c.req.raw,MAX_JSON);
    const parsed = parseJson(bytes) as { callbackURL?: unknown }; // native JSON endpoints share the same structural limits
    // Redirect audience (T47): the vendor echoes callbackURL back to the
    // client as a navigation target. A foreign absolute callback would turn
    // a successful sign-in into an open redirect, so refuse it here.
    if (typeof parsed?.callbackURL === "string" && parsed.callbackURL) {
      const allowed = new Set([new URL(c.req.url).origin, `http://${c.req.header("host")}`, `https://${c.req.header("host")}`, ...(publicOrigin ? [publicOrigin] : [])]);
      let cbOrigin: string | null = null;
      try { cbOrigin = new URL(parsed.callbackURL).origin; } catch { cbOrigin = null; } // relative callbacks stay same-origin
      if (cbOrigin && cbOrigin !== "null" && !allowed.has(cbOrigin)) {
        return c.json(brainError("FORBIDDEN", "foreign callbackURL refused", correlation(c as never)), 403);
      }
    }
    return brain.auth.handler(new Request(c.req.raw,{body:Buffer.from(bytes)}));
  });

  app.get("/health/live", (c) => c.json({ live: true }));
  app.get("/health/ready", async (c) => {
    const h = brain.health();
    return c.json(h, h.ready ? 200 : 503);
  });

  app.get("/v1/setup/status", (c) => {
    const initialized = !!brain.store.control.prepare("SELECT 1 FROM organizations LIMIT 1").get();
    return c.json({ initialized, setupRequired: !initialized && !existsSync(join(dataDir, "RESTORED-SUSPENDED.json")) });
  });

  app.get("/v1/identity", async (c) => {
    try {
      const identity = await actorFor(c);
      const workspaces = brain.store.control.prepare("SELECT DISTINCT w.id AS workspaceId,w.slug AS name,w.status FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id AND m.organization_id=w.organization_id WHERE w.organization_id=? AND m.principal_id=? AND m.revoked_at_ms IS NULL ORDER BY w.slug,w.id LIMIT 1000").all(identity.actor.organizationId, identity.principalId) as Array<{ workspaceId: string; name: string; status: string }>;
      const view: IdentityView = { actor: identity.actor, displayName: identity.humanSession?.displayName ?? identity.principalId, totpEnrolled: !!identity.humanSession?.factorDigest, recoveryRequired: identity.humanSession?.recoveryRequired ?? false, workspaces };
      return c.json(view);
    } catch (e) { return fail(c as never, e); }
  });

  // Local one-time bootstrap (loopback setup flow). Refused once an org exists.
  app.post("/v1/setup", async (c) => {
    try {
      const origin = c.req.header("origin");
      if (origin && origin !== (publicOrigin ?? new URL(c.req.url).origin)) throw new BrainDomainError("FORBIDDEN", "setup origin rejected");
      const body = await readJson(c);
      if (brain.store.control.prepare("SELECT 1 FROM organizations LIMIT 1").get()) {
        throw new BrainDomainError("CONFLICT", "initial setup is already complete");
      }
      const authorization = c.req.header("authorization") ?? "";
      const result = await brain.bootstrap(body, authorization.startsWith("Setup ") ? authorization.slice(6) : "");
      for (const cookie of result.cookies) c.header("set-cookie", cookie, { append: true });
      return c.json({ organizationId: result.organizationId, ownerPrincipalId: result.ownerPrincipalId, sessionToken: result.sessionToken }, 201);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/setup/workspace", async (c) => {
    try {
      const body = (await readJson(c)) as { workspaceId: string; slug: string };
      const { actor } = await actorFor(c);
      brain.createWorkspace(actor, body);
      return c.json({ workspaceId: body.workspaceId }, 201);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/setup/config", async (c) => {
    try {
      const body = (await readJson(c)) as { documents: { path: string; text: string }[]; sourceRevision: string; activate?: boolean };
      const { actor } = await actorFor(c);
      const { digest } = brain.stageRelease(actor, body.documents, body.sourceRevision);
      if (body.activate) brain.activateRelease(actor, digest);
      return c.json({ digest }, 201);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/commands", async (c) => {
    try {
      const raw = await readJson(c);
      const wsId = (raw as { workspaceId?: string }).workspaceId;
      const { actor } = await actorFor(c, wsId);
      const { receipt, status } = brain.executeCommand(actor, raw, correlation(c));
      return c.json(receipt, status as 200);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/query", async (c) => {
    try {
      const raw = await readJson(c);
      const wsId = (raw as { workspaceId?: string }).workspaceId;
      const { actor } = await actorFor(c, wsId);
      // Re-scope actor with workspace scopes when a workspace is named.
      const scoped: ActorContext = wsId ? { ...actor, scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, wsId) } : actor;
      if ((raw as { queryType?: string }).queryType === "memory.search" && wsId) {
        return c.json((await brain.searchMemoryAsync(scoped, wsId, (raw as { memoryQuery: never }).memoryQuery)) as never);
      }
      return c.json(brain.executeQuery(scoped, raw) as never);
    } catch (e) { return fail(c as never, e); }
  });

  app.get("/v1/events", async (c) => {
    try {
      const identity = await actorFor(c);
      const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
      const startCursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
      const frame = (e: { cursor: number; type: string }) => `id: ${e.cursor}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      if (c.req.query("live") !== "1") {
        const events = brain.listEvents(identity.actor, startCursor) as unknown as Array<{ cursor: number; eventId: string; type: string }>;
        return new Response(events.map(frame).join("") + ": keepalive\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
      }
      // Live subscription (T06): replay from the cursor, then stream new
      // authorized events. Authorization is re-resolved periodically so a
      // revoked session loses the stream; a client that falls too far behind
      // receives a reset frame and must resync from a snapshot.
      const maxLag = Math.min(20_000, Math.max(100, Number(c.req.query("maxLag") ?? 5000) || 5000));
      const headers = c.req.raw.headers;
      const encoder = new TextEncoder();
      let cursor = startCursor;
      let closed = false;
      let lastAuthCheck = Date.now();
      let lastHeartbeat = Date.now();
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const close = () => {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            try { controller.close(); } catch { /* already closed */ }
          };
          const tick = async () => {
            if (closed) return;
            try {
              if (Date.now() - lastAuthCheck > 2000) {
                lastAuthCheck = Date.now();
                await brain.resolveActor(headers);
              }
              const head = brain.listEvents(identity.actor, cursor, 200) as unknown as Array<{ cursor: number; eventId: string; type: string }>;
              if (head.length > 0) {
                const newest = head[head.length - 1]!.cursor;
                if (newest - cursor > maxLag) {
                  controller.enqueue(encoder.encode(`event: reset\ndata: ${JSON.stringify({ reason: "cursor-lag", after: cursor })}\n\n`));
                  close();
                  return;
                }
                for (const e of head) controller.enqueue(encoder.encode(frame(e)));
                cursor = newest;
                lastHeartbeat = Date.now();
              } else if (Date.now() - lastHeartbeat > 5000) {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
                lastHeartbeat = Date.now();
              }
            } catch {
              close(); // revoked/expired session or store failure: end the stream
            }
          };
          void tick();
          timer = setInterval(() => { void tick(); }, 200);
          c.req.raw.signal?.addEventListener("abort", close, { once: true });
          setTimeout(close, 55_000).unref?.();
        },
        cancel() { closed = true; if (timer) clearInterval(timer); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/step-up/challenges", async (c) => {
    try {
      const body = (await readJson(c)) as { approvalId: string; subjectDigest: string };
      requireBody("StepUpChallengeRequest", body);
      const identity = await actorFor(c);
      return c.json(brain.stepUp.createChallenge(identity, body.approvalId, body.subjectDigest), 201);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/step-up/verify", async (c) => {
    try {
      const body = (await readJson(c)) as { challengeId: string; code: string };
      requireBody("StepUpVerify", body);
      const identity = await actorFor(c);
      return c.json(await brain.stepUp.verify(identity, body.challengeId, body.code, c.req.raw.headers));
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/approvals/:id/decision", async (c) => {
    try {
      const body = (await readJson(c)) as HumanApprovalDecision;
      const identity = await actorFor(c);
      return c.json(brain.decideApproval(identity, c.req.param("id"), body));
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/approvals/:id/decision-status", async (c) => {
    try {
      const body = (await readJson(c)) as { idempotencyKey: string };
      const { actor } = await actorFor(c);
      return c.json(brain.decisionStatus(actor, c.req.param("id"), body.idempotencyKey) as never);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/artifacts/init", async (c) => {
    try {
      const body = (await readJson(c)) as Record<string, unknown>;
      const { actor } = await actorFor(c, String(body["workspaceId"] ?? ""));
      return c.json(brain.initUpload(actor, body) as never, 201);
    } catch (e) { return fail(c as never, e); }
  });

  app.put("/v1/artifacts/:id/content", async (c) => {
    try {
      const { actor } = await actorFor(c);
      const rawBody = c.req.raw.body;
      if (!rawBody) return c.json(brain.putUpload(actor, c.req.param("id"), new Uint8Array()) as never);
      const reader = rawBody.getReader();
      const chunks: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        },
      };
      return c.json((await brain.putUploadStream(actor, c.req.param("id"), chunks)) as never);
    } catch (e) { return fail(c as never, e); }
  });

  app.get("/v1/artifacts/:id/content", async (c) => {
    try {
      const { actor } = await actorFor(c);
      const bytes = brain.readArtifact(actor, c.req.param("id"));
      return new Response(Buffer.from(bytes), { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" } });
    } catch (e) { return fail(c as never, e); }
  });

  app.get("/v1/push/vapid-public-key", async (c) => {
    try {
      await actorFor(c);
      return c.json({ publicKey: brain.vapidPublicKey() });
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/push/subscriptions", async (c) => {
    try {
      const body = (await readJson(c)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const { actor } = await actorFor(c);
      if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
        return c.json(brainError("INVALID_ARGUMENT", "endpoint and keys.p256dh/auth required", correlation(c)), 400);
      }
      return c.json(brain.registerPushSubscription(actor, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth }), 201);
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/push/subscriptions/delete", async (c) => {
    try {
      const body = (await readJson(c)) as { endpoint?: string };
      const { actor } = await actorFor(c);
      if (!body.endpoint) return c.json(brainError("INVALID_ARGUMENT", "endpoint required", correlation(c)), 400);
      brain.unregisterPushSubscription(actor, body.endpoint);
      return c.json({ revoked: true });
    } catch (e) { return fail(c as never, e); }
  });

  app.post("/v1/runner-tokens", async (c) => {
    try {
      const body = (await readJson(c)) as { groupId: string };
      const { actor } = await actorFor(c);
      return c.json(brain.issueEnrollment(actor, body.groupId), 201);
    } catch (e) { return fail(c as never, e); }
  });

  // Runner protocol (machine credentials; browser cookies rejected in authRunner).
  app.post("/runner/v1/enroll", async (c) => {
    try {
      const body = (await readJson(c)) as { token: string; publicKey: string; runnerId: string };
      return c.json(brain.enrollRunner({ token: body.token, publicKeyPem: body.publicKey, runnerId: body.runnerId }), 201);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/challenges", async (c) => {
    try {
      const body = (await readJson(c)) as { runnerId: string; credential: string };
      return c.json(brain.runnerChallenge(body.runnerId, body.credential), 201);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/hello", async (c) => {
    try {
      const body = (await readJson(c)) as Record<string, unknown>;
      return c.json(brain.runnerHello(body));
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/heartbeat", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      const body = (await readJson(c)) as Record<string, unknown>;
      return c.json(brain.heartbeat(runner, body));
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/claim", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      const body = (await readJson(c)) as { requestId: string };
      brain.expireLeases();
      const offer = brain.claim(runner, body.requestId);
      if (!offer) return new Response(null, { status: 204 });
      return c.json(offer as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.get("/runner/v1/attempts/:id/artifact", (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      const bytes = brain.readExecutionArtifact(runner, c.req.param("id"));
      return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/ack", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.ackAttempt(runner, c.req.param("id"), (await readJson(c)) as Record<string, unknown>) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/renew", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.renewAttempt(runner, c.req.param("id"), (await readJson(c)) as Record<string, unknown>) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/events", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.attemptEvents(runner, c.req.param("id"), (await readJson(c)) as Record<string, unknown>) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/permit", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.issuePermit(runner, c.req.param("id"), (await readJson(c)) as Record<string, unknown>) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/v1/runners/:id/trust", async (c) => {
    try {
      const { actor } = await actorFor(c);
      const body = (await readJson(c)) as { domain?: string; reason?: string };
      return c.json(brain.verifyTrustDomain(actor, { runnerId: c.req.param("id"), domain: String(body.domain ?? ""), reason: String(body.reason ?? "") }) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.delete("/v1/runners/:id/trust", async (c) => {
    try {
      const { actor } = await actorFor(c);
      const body = (await readJson(c)) as { domain?: string; reason?: string };
      brain.revokeTrustDomain(actor, { runnerId: c.req.param("id"), domain: String(body.domain ?? ""), reason: String(body.reason ?? "") });
      return new Response(null, { status: 204 });
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/permits/validate", async (c) => {
    try {
      brain.authRunner(c.req.raw.headers);
      const body = (await readJson(c)) as { token?: string; invocationId?: string };
      const valid = brain.validatePermit(String(body.token ?? ""), String(body.invocationId ?? ""));
      return c.json({ valid });
    } catch (e) { return fail(c as never, e); }
  });
  app.get("/runner/v1/releases/:digest/tools/:toolId", (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      const tool = brain.readReleaseTool(runner, c.req.param("digest"), c.req.param("toolId"));
      return c.json({
        entrypoint: tool.entrypoint, entrypointDigest: tool.entrypointDigest,
        bytesBase64: Buffer.from(tool.bytes).toString("base64"),
      });
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/artifacts", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.acceptAttemptArtifact(runner, c.req.param("id"), (await readJson(c)) as { digest: string; bytesBase64: string; mediaType?: string }) as never, 201);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/complete", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.completeAttempt(runner, c.req.param("id"), (await readJson(c)) as Record<string, unknown>) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/attempts/:id/release", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.releaseAttempt(runner, c.req.param("id"), (await readJson(c)) as Record<string, unknown>) as never);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/evidence", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      return c.json(brain.submitEvidence(runner, (await readJson(c)) as Record<string, unknown>) as never, 201);
    } catch (e) { return fail(c as never, e); }
  });
  app.post("/runner/v1/verdicts", async (c) => {
    try {
      const runner = brain.authRunner(c.req.raw.headers);
      const body = await readJson(c);
      requireBody("RunnerVerdictRequest",body);
      const request=body as RunnerVerdictRequest;
      return c.json(brain.acceptVerdict(runner,request.workspaceId,request.verdict) as never);
    } catch (e) { return fail(c as never, e); }
  });

  // MCP/agent channel shares the same command handlers; approval decisions are absent by design.
  app.post("/mcp", async (c) => {
    try {
      const raw = (await readJson(c)) as { method?: string; params?: { command?: unknown; query?: unknown }; id?: unknown };
      const wsId = (raw.params?.command as { workspaceId?: string } | undefined)?.workspaceId;
      const { actor } = await actorFor(c, wsId);
      if (actor.kind === "human") throw new BrainDomainError("FORBIDDEN", "MCP channel is for agent/delegated actors; humans use web/CLI");
      if (raw.params?.command) {
        const type = (raw.params.command as { commandType?: string }).commandType ?? "";
        if (type.startsWith("approval.") && type !== "approval.request") throw new BrainDomainError("FORBIDDEN", "approval decisions are not available over MCP");
        const { receipt } = brain.executeCommand(actor, raw.params.command, correlation(c));
        return c.json({ jsonrpc: "2.0", id: raw.id ?? null, result: receipt });
      }
      if (raw.params?.query) return c.json({ jsonrpc: "2.0", id: raw.id ?? null, result: brain.executeQuery(actor, raw.params.query) });
      throw new BrainDomainError("INVALID_ARGUMENT", "MCP params.command or params.query required");
    } catch (e) { return fail(c as never, e); }
  });

  // Static web bundle (production). API paths resolve above SPA fallback.
  const gzipCache = new Map<string, Buffer>();
  app.get("*", async (c) => {
    if (/^\/(?:v1|runner|api|health|mcp)(?:\/|$)/u.test(c.req.path)) {
      return c.json(brainError("NOT_FOUND", "endpoint not found", correlation(c)), 404);
    }
    // Resolve the web bundle independent of the process cwd (container and
    // package-script launches run from apps/governor, not the repo root).
    const distCandidates = [
      process.env["BRAIN_WEB_DIST_DIR"],
      join(process.cwd(), "apps/web/dist"),
      join(process.cwd(), "../web/dist"),
      join(import.meta.dirname, "../../../web/dist"),
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    const dist = distCandidates.find((p) => existsSync(join(p, "index.html"))) ?? distCandidates[0]!;
    const path = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\//, "");
    const file = join(dist, path);
    const serveFile = (target: string, type: string) => {
      const bytes = readFileSync(target);
      const compressible = type.startsWith("text/") || type === "text/javascript";
      const wantsGzip = (c.req.header("accept-encoding") ?? "").includes("gzip");
      if (compressible && wantsGzip && bytes.length > 1024) {
        const key = `${target}:${statSync(target).mtimeMs}`;
        let gz = gzipCache.get(key);
        if (!gz) { gz = gzipSync(bytes); gzipCache.set(key, gz); }
        return new Response(gz as BodyInit, { headers: { "content-type": type, "content-encoding": "gzip", vary: "accept-encoding" } });
      }
      return new Response(Buffer.from(bytes), { headers: { "content-type": type } });
    };
    if (existsSync(file) && !file.includes("..")) {
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".webmanifest") ? "application/manifest+json" : "text/html";
      return serveFile(file, type);
    }
    const index = join(dist, "index.html");
    if (existsSync(index)) return serveFile(index, "text/html");
    return c.json(brainError("NOT_FOUND", "web bundle not built; run pnpm --filter @brain/web build", correlation(c)), 404);
  });

  app.notFound((c) => c.json(brainError("NOT_FOUND", "endpoint not found", correlation(c)), 404));

  let server: ReturnType<typeof serve> | undefined;
  return {
    brain,
    fetch: (request: Request) => app.fetch(request),
    async listen() {
      const port = Number(process.env["PORT"] ?? 3000);
      const tls = tlsMaterialFromEnv();
      if (tls) {
        const { createServer: createHttpsServer } = await import("node:https");
        server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1", createServer: createHttpsServer, serverOptions: { cert: tls.cert, key: tls.key } } as never) as typeof server;
        console.log(`Brain Governor listening on https://127.0.0.1:${port}`);
      } else {
        server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
        console.log(`Brain Governor listening on http://127.0.0.1:${port}`);
      }
      const stop = () => { server?.close(); brain.close(); process.exit(0); };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      setInterval(() => {
    try { brain.expireLeases(); brain.projectOutbox(); } catch { /* timers never authorize */ }
    // Cron dispatch runs on its own cadence; a pass is idempotent and cheap.
    try { brain.runScheduledDispatch(); } catch { /* a bad release must not break expiry */ }
  }, 5000).unref();
    },
    async close() {
      server?.close();
      brain.close();
    },
  };
}
