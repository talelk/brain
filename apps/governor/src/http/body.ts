import { BrainDomainError } from "../domain/errors";
import { parseStrictJson } from "@brain/contracts";

// Per-Governor admission, independent of runner slots. Reserve the worst-case
// bounded body before reading so uploads cannot exhaust the control process.
export class BodyReader {
  private reserved = 0;
  constructor(private readonly budgetBytes = 128 * 1024 * 1024, private readonly timeoutMs = 15_000) {}

  async read(request: Request, maximum: number): Promise<Uint8Array> {
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) throw new BrainDomainError("INVALID_ARGUMENT", "invalid content length");
    if (length !== null && Number(length) > maximum) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "request body exceeds its byte limit");
    if (this.reserved + maximum > this.budgetBytes) throw new BrainDomainError("RATE_LIMITED", "request body capacity is busy; retry later");
    if (!request.body) {
      if (length !== null && Number(length) !== 0) throw new BrainDomainError("INVALID_ARGUMENT", "request body length mismatch");
      return new Uint8Array();
    }
    this.reserved += maximum;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrainDomainError("INVALID_ARGUMENT", "request body timed out")), this.timeoutMs);
      timer.unref?.();
    });
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      reader = request.body.getReader();
      for (;;) {
        if (request.signal.aborted) throw new BrainDomainError("INVALID_ARGUMENT", "request body aborted");
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maximum) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "request body exceeds its byte limit");
        chunks.push(chunk.value);
      }
      if (length !== null && total !== Number(length)) throw new BrainDomainError("INVALID_ARGUMENT", "request body length mismatch");
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } catch (e) { void reader?.cancel().catch(() => {}); throw e; }
    finally { if (timer) clearTimeout(timer); try { reader?.releaseLock(); } finally { this.reserved -= maximum; } }
  }
}

export function parseJson(bytes: Uint8Array): unknown {
  let value: unknown;
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    value = text.trim() ? parseStrictJson(text) : {};
  } catch (e) {
    if (e instanceof Error && ["JSON_TOO_DEEP", "JSON_TOO_COMPLEX"].includes(e.message)) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "JSON structure exceeds its limit");
    throw new BrainDomainError("INVALID_CONTRACT", "body is not valid UTF-8 JSON");
  }
  return value;
}
