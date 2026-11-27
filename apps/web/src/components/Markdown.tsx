import { For, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { markdownBlocks, parseInline, type Block, type ListNode } from "../lib/markdown-parse";
import { readConcept } from "@brain/contracts/okf";

/**
 * Markdown a person reads: a result, findings, a prompt. A small, safe subset parsed into text nodes (headings, paragraphs, emphasis,
 * code, http links, lists, quotes, fenced code, rules, tables). It never injects HTML. Headings start at h3, under the page's own.
 */
function Inline(props: { text: string }): JSX.Element {
  return (
    <For each={parseInline(props.text)}>
      {(part) => {
        if (part.kind === "strong") return <strong><Inline text={part.text} /></strong>;
        if (part.kind === "em") return <em><Inline text={part.text} /></em>;
        if (part.kind === "code") return <code class="code-ltr">{part.text}</code>;
        if (part.kind === "link") return <a href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>;
        return part.text;
      }}
    </For>
  );
}

function List(props: { list: ListNode }): JSX.Element {
  const items = (): JSX.Element => <For each={props.list.items}>{(item) => <li><Inline text={item.text} /><For each={item.children}>{(child) => <List list={child} />}</For></li>}</For>;
  return <Show when={props.list.ordered} fallback={<ul>{items()}</ul>}><ol>{items()}</ol></Show>;
}

const HEADINGS = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;

function block(item: Block): JSX.Element {
  switch (item.kind) {
    case "heading": return <Dynamic component={HEADINGS[Math.min(item.level, 6) - 1] ?? "h6"}><Inline text={item.text} /></Dynamic>;
    case "paragraph": return <p><Inline text={item.text} /></p>;
    case "quote": return <blockquote><Inline text={item.text} /></blockquote>;
    case "code": return <pre><code>{item.text}</code></pre>;
    case "list": return <List list={item.list} />;
    case "hr": return <hr />;
    case "table":
      return (
        <div class="prose-table">
          <table>
            <thead><tr><For each={item.header}>{(cell) => <th><Inline text={cell} /></th>}</For></tr></thead>
            <tbody><For each={item.rows}>{(row) => <tr><For each={row}>{(cell) => <td><Inline text={cell} /></td>}</For></tr>}</For></tbody>
          </table>
        </div>
      );
  }
}

/** A file that is an Open Knowledge Format concept is read as its title and body, without the rest of its frontmatter. */
const bodyOf = (text: string): string => {
  const read = readConcept(text);
  if ("problem" in read) return text;
  return read.title === undefined || read.body.split("\n")[0] === `# ${read.title}` ? read.body : `# ${read.title}\n\n${read.body}`;
};

/** `file`: the text is a file's content, whose frontmatter is not part of what is read. */
export function Markdown(props: { text: string; file?: boolean; class?: string }): JSX.Element {
  return <div class={`prose-brain ${props.class ?? ""}`} dir="auto"><For each={markdownBlocks(props.file ? bodyOf(props.text) : props.text)}>{block}</For></div>;
}
