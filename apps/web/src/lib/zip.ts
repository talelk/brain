/** Just enough zip for the browser: files stored in one archive to download, and the text parts of an office file read for a preview. */

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { readonly name: string; readonly bytes: Uint8Array }

/** An archive that stores the files as they are (no compression), names in UTF-8. */
export function zipOf(entries: readonly ZipEntry[]): Blob {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, entry.bytes.length, true); local.setUint32(22, entry.bytes.length, true); local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, entry.bytes as BlobPart);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(4, 20, true); head.setUint16(6, 20, true); head.setUint16(8, 0x0800, true);
    head.setUint32(16, crc, true); head.setUint32(20, entry.bytes.length, true); head.setUint32(24, entry.bytes.length, true); head.setUint16(28, name.length, true); head.setUint32(42, offset, true);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + entry.bytes.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: "application/zip" });
}

/** Fetches each file (name and address) and saves them as one zip through the browser's own download. */
export async function downloadZip(files: readonly { readonly name: string; readonly url: string }[], saveAs: string): Promise<void> {
  const entries = await Promise.all(files.map(async (file) => {
    const response = await fetch(file.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(file.name);
    return { name: file.name, bytes: new Uint8Array(await response.arrayBuffer()) };
  }));
  const link = document.createElement("a");
  link.href = URL.createObjectURL(zipOf(entries));
  link.download = saveAs;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** The text of the named parts of a zip (an office file is one), or nothing for a part that is missing. Only stored and deflated parts are read. */
export async function zipText(buffer: ArrayBuffer, names: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const found = new Map<string, string>();
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) return found;
  let at = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0 && view.getUint32(at, true) === 0x02014b50; n -= 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    if (!names(name) || (method !== 0 && method !== 8)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.slice(start, start + size);
    const raw = method === 0 ? data : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    found.set(name, new TextDecoder().decode(raw));
  }
  return found;
}

/** The first sheet of a spreadsheet file as rows of text (at most `limit` rows). */
export async function sheetOf(buffer: ArrayBuffer, limit = 200): Promise<string[][]> {
  const parts = await zipText(buffer, (name) => name === "xl/sharedStrings.xml" || name === "xl/worksheets/sheet1.xml");
  const parse = (xml: string): Document => new DOMParser().parseFromString(xml, "application/xml");
  const shared = [...parse(parts.get("xl/sharedStrings.xml") ?? "<x/>").getElementsByTagName("si")].map((item) => [...item.getElementsByTagName("t")].map((node) => node.textContent ?? "").join(""));
  const rows: string[][] = [];
  for (const row of [...parse(parts.get("xl/worksheets/sheet1.xml") ?? "<x/>").getElementsByTagName("row")].slice(0, limit)) {
    const cells: string[] = [];
    for (const cell of [...row.getElementsByTagName("c")]) {
      const column = [...(cell.getAttribute("r") ?? "")].filter((ch) => ch >= "A" && ch <= "Z").reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const value = cell.getElementsByTagName("v")[0]?.textContent ?? cell.getElementsByTagName("t")[0]?.textContent ?? "";
      cells[column < 0 ? cells.length : column] = cell.getAttribute("t") === "s" ? (shared[Number(value)] ?? "") : value;
    }
    rows.push(Array.from(cells, (value) => value ?? ""));
  }
  return rows;
}
