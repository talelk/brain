import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { BrokerResult } from "./brokers";

/**
 * The per-run output directory (backlog 88). A tool call such as `files.write` lets an agent produce files (a report, a table) without
 * any reach into the host: each attempt owns one empty folder under the runner's own state directory, the broker below is the only
 * writer, and at the end of a successful attempt the runner collects what is in it as artifacts of that attempt and deletes the folder.
 *
 * Nothing here trusts a name or a file it finds: names are plain relative paths of a few safe characters (no `..`, no dot-files, no
 * absolute paths), every path component is checked with lstat so a symlink is never followed, a file is created with O_NOFOLLOW, and
 * collection reads only regular files inside the folder, within fixed counts and sizes.
 */

export const OUTPUT_LIMITS = { files: 20, fileBytes: 200_000, totalBytes: 1_000_000, depth: 3 } as const;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html", yaml: "application/yaml", yml: "application/yaml", log: "text/plain",
};

/** The media type for a file name, or undefined when the extension is not one a result may carry. */
export function mediaTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** A plain reason when the name cannot be a file of the output folder, else undefined. */
export function refuseName(name: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return "name must be a relative file name of up to 200 characters";
  const segments = name.split("/");
  if (segments.length > OUTPUT_LIMITS.depth) return `name may have at most ${OUTPUT_LIMITS.depth} folder levels`;
  if (!segments.every((segment) => SEGMENT.test(segment) && !segment.includes(".."))) return "name may use only letters, digits, dot, dash and underscore in each part, starting with a letter or digit, with no .. and no absolute path";
  if (!mediaTypeOf(segments.at(-1)!)) return `name must end in one of: ${Object.keys(MEDIA_TYPES).map((extension) => `.${extension}`).join(", ")}`;
  return undefined;
}

export interface CollectedFile { readonly name: string; readonly bytes: Uint8Array; readonly mediaType: string }

export class RunOutputDir {
  readonly dir: string;
  constructor(stateDir: string, attemptId: string) {
    if (!/^[A-Za-z0-9_-]+$/u.test(attemptId)) throw new Error("invalid attempt id");
    this.dir = join(stateDir, "run-output", attemptId);
  }

  /** Writes one file. A refusal is a plain failed call with a reason the model can act on; nothing outside the folder is ever touched. */
  write(input: Readonly<Record<string, unknown>>): BrokerResult {
    const reason = refuseName(input["name"]);
    if (reason) return { ok: false, error: reason };
    const content = input["content"];
    if (typeof content !== "string") return { ok: false, error: "content must be text" };
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > OUTPUT_LIMITS.fileBytes) return { ok: false, error: `a file may hold at most ${OUTPUT_LIMITS.fileBytes} bytes` };
    const name = String(input["name"]);
    const existing = this.list();
    const replaced = existing.find((entry) => entry.name === name);
    if (!replaced && existing.length >= OUTPUT_LIMITS.files) return { ok: false, error: `the run's output folder holds at most ${OUTPUT_LIMITS.files} files` };
    const total = existing.reduce((sum, entry) => sum + (entry.name === name ? 0 : entry.bytes), 0) + bytes.length;
    if (total > OUTPUT_LIMITS.totalBytes) return { ok: false, error: `the run's output folder holds at most ${OUTPUT_LIMITS.totalBytes} bytes in all` };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.assertPlain(this.dir);
      const segments = name.split("/");
      let current = this.dir;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        this.assertPlain(current);
      }
      const target = join(current, segments.at(-1)!);
      // O_NOFOLLOW: a symlink planted at the target (by a tool's own script, say) makes this open fail instead of writing through it.
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { if (!fstatSync(fd).isFile()) throw new Error("not a regular file"); writeSync(fd, bytes); } finally { closeSync(fd); }
    } catch (error) {
      return { ok: false, error: `the file could not be written (${error instanceof Error ? error.message.replace(this.dir, "<output>").slice(0, 120) : "unknown error"})` };
    }
    const after = this.list();
    return { ok: true, data: { name, bytes: bytes.length, files: after.length, totalBytes: after.reduce((sum, entry) => sum + entry.bytes, 0), replaced: !!replaced } };
  }

  private assertPlain(path: string): void {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("a path in the output folder is not a plain folder");
  }

  /** The regular files in the folder, found without following links; anything else (links, devices, deeper trees) is ignored. */
  private list(): Array<{ name: string; bytes: number }> {
    const found: Array<{ name: string; bytes: number }> = [];
    const walk = (folder: string, prefix: string, level: number): void => {
      let entries: string[];
      try { entries = readdirSync(folder).sort(); } catch { return; }
      for (const entry of entries) {
        const path = join(folder, entry);
        const info = lstatSync(path);
        const name = prefix ? `${prefix}/${entry}` : entry;
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { if (level < OUTPUT_LIMITS.depth) walk(path, name, level + 1); continue; }
        if (info.isFile() && refuseName(name) === undefined) found.push({ name, bytes: info.size });
      }
    };
    try { this.assertPlain(this.dir); } catch { return found; } // a missing folder, or a root swapped for a link, holds nothing
    walk(this.dir, "", 1);
    return found;
  }

  /** The files to attach to the attempt: only regular files that still pass the name rules, within the counts and sizes, in a stable order. */
  collect(): CollectedFile[] {
    const files: CollectedFile[] = [];
    let total = 0;
    for (const entry of this.list()) {
      if (files.length >= OUTPUT_LIMITS.files || entry.bytes > OUTPUT_LIMITS.fileBytes || total + entry.bytes > OUTPUT_LIMITS.totalBytes) continue;
      const path = join(this.dir, ...entry.name.split("/"));
      try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!fstatSync(fd).isFile()) continue;
          const bytes = new Uint8Array(readFileSync(fd)); // read through the descriptor that was checked, never the path again
          if (bytes.length > OUTPUT_LIMITS.fileBytes) continue;
          files.push({ name: entry.name, bytes, mediaType: mediaTypeOf(entry.name)! });
          total += bytes.length;
        } finally { closeSync(fd); }
      } catch { /* a file that changed into something else while collecting is left out */ }
    }
    return files;
  }

  /** Removes the folder. Safe to call twice and when nothing was ever written. */
  dispose(): void { rmSync(this.dir, { recursive: true, force: true }); }
}
