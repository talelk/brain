import { hmacSha256Hex, secretName, type JsonValue } from "@brain/contracts";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { readSecret } from "../trust/secrets";

/**
 * The workspace's webhook (docs/model.md, "Systems that follow work"): what Teams is told, as a CloudEvent another system reads, signed
 * with the webhook's secret over the exact bytes sent.
 */
export interface Happened {
  /** The position of the event in the audit log: the same event is the same id, however often it is sent. */
  readonly id: number;
  readonly type: string;
  readonly atMs: number;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly taskId: string;
  readonly data: { readonly title: string; readonly goal: boolean; readonly need?: string; readonly url: string };
}

/** Waits before the second and third try. A delivery that fails them all is dropped and recorded. */
const RETRY_AFTER_MS = [500, 2_000] as const;

export async function postEvent(gov: Gov, to: { readonly url: string; readonly secret: string }, happened: Happened): Promise<void> {
  const signing = readSecret(gov, happened.workspaceId, secretName(to.secret));
  const body = JSON.stringify({
    specversion: "1.0", id: String(happened.id), source: `${gov.baseUrl}/w/${happened.workspaceSlug}`, type: `brain.${happened.type}`, subject: happened.taskId,
    time: new Date(happened.atMs).toISOString(), datacontenttype: "application/json", data: { workspaceId: happened.workspaceId, taskId: happened.taskId, ...happened.data },
  });
  let problem = signing === undefined ? `the secret ${secretName(to.secret)} is not set` : "";
  if (signing !== undefined) {
    const headers = { "content-type": "application/cloudevents+json", "user-agent": "Brain", "x-brain-signature-256": `sha256=${hmacSha256Hex(Buffer.from(signing, "utf8"), Buffer.from(body, "utf8"))}` };
    for (const wait of [0, ...RETRY_AFTER_MS]) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        const answer = await gov.fetch(to.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (answer.ok) return;
        problem = `it answered ${answer.status}`;
      } catch {
        problem = "it did not answer";
      }
    }
  }
  const failed: JsonValue = { event: happened.id, type: happened.type, taskId: happened.taskId, message: problem };
  tx(gov.db, () => append(gov.db, { type: "webhook.failed", workspaceId: happened.workspaceId, subject: `workspace:${happened.workspaceId}`, payload: failed, actor: SYSTEM }));
}
