import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { JSX } from "solid-js";
import "./prose.css";

/**
 * Long-form Markdown for people (a task's written deliverable). A small, safe
 * subset parsed line by line into JSX text nodes: headings, paragraphs, bold,
 * italic, inline code, http(s) links, bullet and numbered lists (nested by
 * indent), quotes, fenced code, rules and pipe tables. It never injects HTML.
 * Typography lives in `.brain-prose` (index.css); headings start at h3 so a
 * document never re-shapes the page outline.
 */

type Inline = { kind: "text" | "strong" | "em" | "code"; text: string } | { kind: "link"; text: string; href: string };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/gu;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    const token = match[0];
    if (match[1]) out.push({ kind: "code", text: token.slice(1, -1) });
    else if (match[2]) out.push({ kind: "strong", text: token.slice(2, -2) });
    else if (match[3]) out.push({ kind: "em", text: token.slice(1, -1) });
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      out.push(parts ? { kind: "link", text: parts[1] ?? "", href: parts[2] ?? "" } : { kind: "text", text: token });
    }
    last = at + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

function Inlines(props: { text: string }): JSX.Element {
  return (
    <For each={parseInline(props.text)}>
      {(part) => {
        if (part.kind === "strong") return <strong>{part.text}</strong>;
        if (part.kind === "em") return <em>{part.text}</em>;
        if (part.kind === "code") return <code>{part.text}</code>;
        if (part.kind === "link") return <a href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>;
        return part.text;
      }}
    </For>
  );
}

interface ListItem { text: string; children: ListNode[] }
interface ListNode { ordered: boolean; items: ListItem[] }
type Align = "left" | "right" | "center" | undefined;
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; list: ListNode }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "hr" };

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;
const splitRow = (line: string): string[] => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
const isThematicBreak = (line: string) => {
  const marks = line.replaceAll(/\s/gu, "");
  return marks.length >= 3 && /^(-+|\*+|_+)$/u.test(marks);
};
const isRule = (line: string) => line.includes("-") && line.includes("|") && splitRow(line).every((cell) => /^:?-{2,}:?$/u.test(cell));

export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (/^\s*```/u.test(line)) {
      flush();
      const body: string[] = [];
      for (index += 1; index < lines.length && !/^\s*```/u.test(lines[index] ?? ""); index += 1) body.push(lines[index] ?? "");
      blocks.push({ kind: "code", text: body.join("\n") });
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (isThematicBreak(line)) {
      flush();
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }
    if (line.includes("|") && isRule(lines[index + 1] ?? "")) {
      flush();
      const header = splitRow(line);
      const align = splitRow(lines[index + 1] ?? "").map((cell): Align => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined));
      const rows: string[][] = [];
      for (index += 2; index < lines.length && (lines[index] ?? "").includes("|"); index += 1) rows.push(splitRow(lines[index] ?? ""));
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }
    if (/^\s*>/u.test(line)) {
      flush();
      const body: string[] = [];
      for (; index < lines.length && /^\s*>/u.test(lines[index] ?? ""); index += 1) body.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const first = BULLET.exec(line);
    if (first) {
      flush();
      const root: ListNode = { ordered: /\d/u.test(first[2] ?? ""), items: [] };
      const stack: { indent: number; list: ListNode }[] = [{ indent: (first[1] ?? "").length, list: root }];
      for (; index < lines.length; index += 1) {
        const raw = lines[index] ?? "";
        const match = BULLET.exec(raw);
        if (!match) {
          // A wrapped continuation line belongs to the previous item; a blank or unrelated line ends the list.
          const tail = stack[stack.length - 1]?.list.items.at(-1);
          if (tail && /^\s{2,}\S/u.test(raw) && !/^\s*(```|#|>)/u.test(raw)) { tail.text += ` ${raw.trim()}`; continue; }
          break;
        }
        const indent = (match[1] ?? "").length;
        while (stack.length > 1 && indent < (stack[stack.length - 1]?.indent ?? 0)) stack.pop();
        const top = stack[stack.length - 1]!;
        if (indent > top.indent) {
          const parent = top.list.items.at(-1) ?? { text: "", children: [] };
          if (!top.list.items.includes(parent)) top.list.items.push(parent);
          const child: ListNode = { ordered: /\d/u.test(match[2] ?? ""), items: [] };
          parent.children.push(child);
          stack.push({ indent, list: child });
        }
        stack[stack.length - 1]!.list.items.push({ text: match[3] ?? "", children: [] });
      }
      blocks.push({ kind: "list", list: root });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
}

function ListView(props: { list: ListNode }): JSX.Element {
  const items = () => (
    <For each={props.list.items}>
      {(item) => (
        <li>
          <Inlines text={item.text} />
          <For each={item.children}>{(child) => <ListView list={child} />}</For>
        </li>
      )}
    </For>
  );
  return <Show when={props.list.ordered} fallback={<ul>{items()}</ul>}><ol>{items()}</ol></Show>;
}

/** The document's `#` is the h3 under the page's own headings; deeper levels step down from there. */
const HEADING_TAGS = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;

function renderBlock(block: Block): JSX.Element {
  switch (block.kind) {
    case "heading":
      return <Dynamic component={HEADING_TAGS[Math.min(block.level, 6) - 1] ?? "h6"} data-level={block.level}><Inlines text={block.text} /></Dynamic>;
    case "paragraph": return <p><Inlines text={block.text} /></p>;
    case "quote": return <blockquote><Inlines text={block.text} /></blockquote>;
    case "code": return <pre><code>{block.text}</code></pre>;
    case "list": return <ListView list={block.list} />;
    case "hr": return <hr />;
    case "table":
      return (
        <section class="brain-prose-table" tabindex="0" aria-label="Table">
          <table>
            <thead><tr><For each={block.header}>{(cell, i) => <th style={{ "text-align": block.align[i()] ?? "start" }}><Inlines text={cell} /></th>}</For></tr></thead>
            <tbody>
              <For each={block.rows}>{(row) => <tr><For each={row}>{(cell, i) => <td style={{ "text-align": block.align[i()] ?? "start" }}><Inlines text={cell} /></td>}</For></tr>}</For>
            </tbody>
          </table>
        </section>
      );
  }
}

export function Markdown(props: { text: string; class?: string }): JSX.Element {
  return (
    <div class={`brain-prose ${props.class ?? ""}`} data-testid="markdown">
      <For each={markdownBlocks(props.text)}>{(block) => renderBlock(block)}</For>
    </div>
  );
}
