import { inflateSync } from "node:zlib";

/**
 * Applies the output of `git diff --binary` to files, without git. Pure: bytes in, bytes out. Patch and contents are handled as latin1
 * text, one character per byte, so nothing is decoded and encoded again; only paths are read as UTF-8.
 *
 * Sections apply in order, each to the result of the ones before it, which is what several diffs one after the other need. A single diff
 * made with `-C` or `-B` can differ: its copies and renames read a file as it was before the diff, so one whose file an earlier section
 * of the same diff changed gets the changed content here. Diffs made without those options have no such section.
 */

/** One file after a patch: `content` undefined means the file is deleted. `mode` is the git file mode when the patch states one ("100644", "100755", "120000"). */
export interface PatchedFile { readonly path: string; readonly content?: Uint8Array; readonly mode?: string }

/** A patch that does not apply: `paths` are the files whose hunks did not fit. */
export class PatchConflict extends Error {
  constructor(readonly paths: readonly string[]) { super(`the patch does not apply: conflict in ${paths.join(", ")}`); this.name = "PatchConflict"; }
}

interface Section { readonly header: string[]; readonly body: string[] }
interface State { readonly text: string | undefined; readonly mode: string | undefined }

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const malformed = (what: string): never => { throw new Error(`the patch is not \`git diff --binary\` output: ${what.trim().slice(0, 120)}`); };

/** The lines of a text, each with its line end. */
function linesOf(text: string): string[] {
  const lines: string[] = [];
  for (let at = 0; at < text.length;) {
    const end = text.indexOf("\n", at) + 1 || text.length;
    lines.push(text.slice(at, end));
    at = end;
  }
  return lines;
}

/** The file sections of a patch: the header lines of each, and the lines after them (hunks, or a binary patch). */
function sectionsOf(patch: Uint8Array): Section[] {
  const sections: Section[] = [];
  let inBody = false;
  for (const line of linesOf(latin1(patch))) {
    // No line of a hunk or of a binary patch starts this way: those start with a space, `+`, `-`, `\` or hold no space.
    if (line.startsWith("diff --git ")) {
      sections.push({ header: [], body: [] });
      inBody = false;
    }
    const section = sections.at(-1);
    if (!section) continue;
    inBody ||= line.startsWith("@@ ") || line.startsWith("GIT binary patch");
    (inBody ? section.body : section.header).push(line);
  }
  return sections;
}

/** What a header line such as `new file mode` says, as written. */
const field = (section: Section, name: string): string | undefined => section.header.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1).replace(/\n$/u, "");

const ESCAPES: Readonly<Record<string, string>> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
/** A path without the C-style quotes git writes around unusual bytes; undefined when the text is not one whole path (a lone `"` is none). */
function unquote(raw: string): string | undefined {
  const quoted = /^"((?:[^"\\]|\\.)*)"$/su.exec(raw);
  if (!quoted) return raw.includes("\"") ? undefined : raw;
  return (quoted[1] as string).replace(/\\([0-7]{3}|.)/gsu, (_, code: string) => (code.length === 3 ? String.fromCharCode(Number.parseInt(code, 8)) : ESCAPES[code] ?? code));
}
/** A path without the one folder git puts in front of it (`a/`, `b/`). */
const tail = (path: string): string => path.slice(path.indexOf("/") + 1);

/**
 * The old and the new path of a section, as its `diff --git` line writes them. A path may hold spaces, so the line is split where both
 * sides name the same file, or the files of the rename or copy lines.
 */
function sides(section: Section): [string, string] {
  const rest = field(section, "diff --git") ?? "";
  const moved = (end: string): string | undefined => unquote(field(section, `rename ${end}`) ?? field(section, `copy ${end}`) ?? "\"");
  const from = moved("from"), to = moved("to");
  // With `--src-prefix` the `diff --git` line has folders in front of the path that the rename and copy lines do not have.
  const names = (path: string, name: string): boolean => path === name || path.endsWith(`/${name}`);
  for (let at = rest.indexOf(" "); at >= 0; at = rest.indexOf(" ", at + 1)) {
    const left = unquote(rest.slice(0, at)), right = unquote(rest.slice(at + 1));
    if (left === undefined || right === undefined) continue;
    if (from === undefined || to === undefined ? tail(left) === tail(right) : names(tail(left), from) && names(tail(right), to)) return [rest.slice(0, at), rest.slice(at + 1)];
  }
  return malformed(`diff --git ${rest}`);
}

/** The text with the hunks applied, or undefined when a hunk does not fit: each must match byte for byte at the line it states. */
function applyHunks(text: string, body: readonly string[]): string | undefined {
  const lines = linesOf(text);
  const out: string[] = [];
  let cursor = 0;
  for (let at = 0; at < body.length;) {
    const head = /^@@ -(\d+),?(\d*) \+\d+,?(\d*) @@/u.exec(body[at] as string);
    at += 1;
    // What follows a complete hunk and is not a hunk is not part of the patch; git skips it too.
    if (!head) continue;
    // A count that is not written is 1.
    const start = Number(head[1]), olds = Number(head[2] || 1), news = Number(head[3] || 1);
    const before: string[] = [], after: string[] = [];
    let last = "";
    for (; before.length < olds || after.length < news || body[at]?.startsWith("\\"); at += 1) {
      const line = body[at] ?? malformed("a hunk ends early"), kind = line.charAt(0), rest = line.slice(1);
      if (kind === "\\") {
        // `\ No newline at end of file`: the line before it has no line end.
        if (last !== "+") before.push((before.pop() ?? "").replace(/\n$/u, ""));
        if (last !== "-") after.push((after.pop() ?? "").replace(/\n$/u, ""));
        continue;
      }
      if (kind !== " " && kind !== "-" && kind !== "+") return malformed(line);
      if (kind !== "+") before.push(rest);
      if (kind !== "-") after.push(rest);
      last = kind;
    }
    // A hunk that only adds states the line it adds after.
    const from = olds === 0 ? start : start - 1;
    if (from < cursor || from > lines.length || before.some((line, index) => lines[from + index] !== line)) return undefined;
    out.push(lines.slice(cursor, from).join(""), after.join(""));
    cursor = from + before.length;
  }
  return out.join("") + lines.slice(cursor).join("");
}

/** The value of each character of git's base85, by character code. */
const BASE85 = new Uint8Array(128);
[..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~"].forEach((char, value) => { BASE85[char.charCodeAt(0)] = value; });

/** Git's delta: the sizes of the old and the new content, then instructions that copy a range of the old content or carry bytes of their own. */
function applyDelta(base: string, delta: Buffer): string | undefined {
  let at = 0;
  const size = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = delta[at++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  if (size() !== base.length) return undefined;
  const length = size();
  const out: string[] = [];
  while (at < delta.length) {
    const op = delta[at++] as number;
    if (op & 0x80) {
      let offset = 0, count = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) offset += (delta[at++] ?? 0) * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) count += (delta[at++] ?? 0) << (8 * bit);
      out.push(base.slice(offset, offset + (count || 0x10000)));
    } else {
      out.push(delta.toString("latin1", at, at + op));
      at += op;
    }
  }
  const text = out.join("");
  return text.length === length ? text : malformed("binary delta of the wrong size");
}

/**
 * The content after a binary section: its first block, deflated and written as base85 lines that each start with their byte count.
 * `literal` is the new content; `delta` is applied to the old content, and is undefined when it was made for content of another size.
 */
function applyBinary(text: string, body: readonly string[]): string | undefined {
  const head = /^(literal|delta) (\d+)\n$/u.exec(body[1] ?? "") ?? malformed(body[1] ?? "GIT binary patch");
  const chunks: Buffer[] = [];
  for (let at = 2; at < body.length && body[at] !== "\n"; at += 1) {
    const line = body[at] as string, code = line.charCodeAt(0);
    // `A` to `Z` is 1 to 26 bytes, `a` to `z` is 27 to 52.
    const length = code >= 97 ? code - 70 : code - 64;
    const chunk = Buffer.alloc(Math.ceil(length / 4) * 4);
    for (let group = 0; group * 4 < length; group += 1) {
      let value = 0;
      for (let index = 1; index <= 5; index += 1) value = value * 85 + (BASE85[line.charCodeAt(group * 5 + index)] ?? 0);
      chunk.writeUInt32BE(value >>> 0, group * 4);
    }
    chunks.push(chunk.subarray(0, length));
  }
  const data = inflateSync(Buffer.concat(chunks));
  if (data.length !== Number(head[2])) return malformed(`binary ${head[1]} of the wrong size`);
  return head[1] === "literal" ? data.toString("latin1") : applyDelta(text, data);
}

/** Applies the patch. `read` returns the current bytes of a path, or undefined when the file does not exist. Returns the final state of every file the patch touches, each path once, in first-touched order. Throws PatchConflict naming every conflicting path (it tries all files before throwing). */
export function applyPatch(patch: Uint8Array, read: (path: string) => Uint8Array | undefined): PatchedFile[] {
  const files = new Map<string, State>();
  const conflicts = new Set<string>();
  const state = (path: string): State => {
    const known = files.get(path);
    if (known) return known;
    const bytes = read(path);
    return { text: bytes && latin1(bytes), mode: undefined };
  };
  for (const section of sectionsOf(patch)) {
    const [oldPath, newPath] = sides(section).map((raw) => Buffer.from(tail(unquote(raw) as string), "latin1").toString("utf8")) as [string, string];
    if (field(section, "Binary files") !== undefined) return malformed(`binary file ${newPath} without its content`);
    const created = field(section, "new file mode");
    const source = created === undefined ? state(oldPath) : { text: "", mode: undefined };
    const mode = created ?? field(section, "new mode") ?? /^[0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/u.exec(field(section, "index") ?? "")?.[1] ?? source.mode;
    const text = source.text === undefined ? undefined : section.body[0]?.startsWith("GIT binary patch") ? applyBinary(source.text, section.body) : applyHunks(source.text, section.body);
    // A file the section creates (new, renamed to or copied to) may be there already only with the same content.
    const existing = created !== undefined || oldPath !== newPath ? state(newPath).text : undefined;
    if (text === undefined || (existing !== undefined && existing !== text)) {
      conflicts.add(newPath);
      continue;
    }
    if (field(section, "rename from") !== undefined) files.set(oldPath, { text: undefined, mode: undefined });
    files.set(newPath, field(section, "deleted file mode") === undefined ? { text, mode } : { text: undefined, mode: undefined });
  }
  if (conflicts.size > 0) throw new PatchConflict([...conflicts]);
  return [...files].map(([path, { text, mode }]) => ({ path, ...(text === undefined ? {} : { content: bytesOf(text) }), ...(mode === undefined ? {} : { mode }) }));
}

/** The part of a working-copy patch that concerns one project: the file sections whose paths start with `<project>/`, with that prefix removed from every path (`diff --git`, `---`, `+++`, `rename from/to`, `copy from/to` lines). Other sections are dropped. */
export function projectPatch(patch: Uint8Array, project: string): Uint8Array {
  const prefix = `${project}/`;
  const without = (raw: string, at: number): string | undefined => (raw.startsWith(prefix, at) ? raw.slice(0, at) + raw.slice(at + prefix.length) : undefined);
  /** A path written after git's `a/` or `b/`, which stays. */
  const inFolder = (raw: string): string | undefined => without(raw, raw.indexOf("/") + 1);
  const kept: string[] = [];
  for (const section of sectionsOf(patch)) {
    const [left, right] = sides(section).map(inFolder);
    if (left === undefined || right === undefined) continue;
    for (const line of section.header) {
      const [, name, raw] = /^(---|\+\+\+|rename from|rename to|copy from|copy to) (.*)$/su.exec(line) ?? [];
      if (line.startsWith("diff --git ")) kept.push(`diff --git ${left} ${right}\n`);
      else if (name === undefined || raw === undefined || raw.startsWith("/dev/null")) kept.push(line);
      // The rename and copy lines of a patch made with `--src-prefix` do not carry the prefix; those stay as they are.
      else kept.push(`${name} ${(name === "---" || name === "+++" ? inFolder(raw) : without(raw, raw.startsWith("\"") ? 1 : 0)) ?? raw}`);
    }
    kept.push(section.body.join(""));
  }
  return bytesOf(kept.join(""));
}
