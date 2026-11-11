import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { JSX } from "solid-js";
import { markdownBlocks, parseInline } from "./markdown-parse";
import type { Block, ListNode } from "./markdown-parse";
import "./prose.css";

/**
 * Long-form Markdown for people (a task's written deliverable). A small, safe
 * subset parsed line by line into JSX text nodes: headings, paragraphs, bold,
 * italic, inline code, http(s) links, bullet and numbered lists (nested by
 * indent), quotes, fenced code, rules and pipe tables. It never injects HTML.
 * Typography lives in `.brain-prose` (index.css); headings start at h3 so a
 * document never re-shapes the page outline.
 */

/** Inline-only Markdown (bold, italics, code, http(s) links) for single-line agent text; never injects HTML. */
export function InlineMarkdown(props: { text: string }): JSX.Element {
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

function ListView(props: { list: ListNode }): JSX.Element {
  const items = () => (
    <For each={props.list.items}>
      {(item) => (
        <li>
          <InlineMarkdown text={item.text} />
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
      return <Dynamic component={HEADING_TAGS[Math.min(block.level, 6) - 1] ?? "h6"} data-level={block.level}><InlineMarkdown text={block.text} /></Dynamic>;
    case "paragraph": return <p><InlineMarkdown text={block.text} /></p>;
    case "quote": return <blockquote><InlineMarkdown text={block.text} /></blockquote>;
    case "code": return <pre><code>{block.text}</code></pre>;
    case "list": return <ListView list={block.list} />;
    case "hr": return <hr />;
    case "table":
      return (
        <section class="brain-prose-table" tabindex="0" aria-label="Table">
          <table>
            <thead><tr><For each={block.header}>{(cell, i) => <th style={{ "text-align": block.align[i()] ?? "start" }}><InlineMarkdown text={cell} /></th>}</For></tr></thead>
            <tbody>
              <For each={block.rows}>{(row) => <tr><For each={row}>{(cell, i) => <td style={{ "text-align": block.align[i()] ?? "start" }}><InlineMarkdown text={cell} /></td>}</For></tr>}</For>
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
