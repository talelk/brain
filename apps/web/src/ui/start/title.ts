/** Longest mission title the box derives; a Play's own title is never cut. */
const MAX_TITLE = 90;

const capitalise = (text: string): string => (text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text);

/** Words a sentence may open with that only point at the subject ("for choosing ...", "to compare ...", "please ..."). */
const FILLER_OPENINGS = [/^(?:please|kindly)\s+/iu, /^(?:i|we)\s+(?:want|need|would like|would love)\s+to\s+/iu, /^(?:i|we)\s+(?:want|need|would like|would love)\s+you\s+to\s+/iu,/^(?:can|could|would)\s+you\s+/iu, /^(?:for|about|on|regarding|concerning|to|of|re)\s+/iu];
const stripFiller = (text: string): string => {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = FILLER_OPENINGS.reduce((acc, pattern) => acc.replace(pattern, ""), current);
    if (next === current) break;
    current = next;
  }
  return current;
};
/** "choosing a shared tool" reads as a heading once the Play's verb phrase leads: drop the gerund before a determiner. */
const LEADING_GERUND = /^[\p{L}]{3,}ing\s+(?=(?:a|an|the|our|my|your|their|this|these|those|some|each)\b)/iu;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/\s+\S*$/u, "").replace(/[\s,;:-]+$/u, "");
  return `${cut || text.slice(0, max)}…`;
}

/** The sentence as a title fragment: first line, no closing punctuation, no leading filler. */
function fragmentOf(sentence: string, dropGerund: boolean): string {
  let text = (sentence.trim().split("\n")[0] ?? "").replace(/\s+/gu, " ").replace(/[.!?:;,\s]+$/u, "");
  text = stripFiller(text);
  if (dropGerund) text = text.replace(LEADING_GERUND, "");
  return text.trim();
}

/**
 * The title nobody typed. Without a lead it is the sentence, capitalised and stripped of a
 * leading "for"/"to"/"please". With a lead (the Play or the earlier mission it starts from) the lead's
 * title comes first and the sentence follows after a colon, so the name of what was picked is never lost.
 */
export function deriveMissionTitle(sentence: string, lead?: string): string {
  const leadTitle = (lead ?? "").trim();
  const fragment = fragmentOf(sentence, Boolean(leadTitle));
  if (!leadTitle) return capitalise(clip(fragment, 72));
  if (!fragment) return leadTitle;
  if (fragment.toLowerCase().startsWith(leadTitle.toLowerCase())) return capitalise(clip(fragment, MAX_TITLE));
  const room = Math.max(24, MAX_TITLE - leadTitle.length - 2);
  return `${leadTitle}: ${clip(fragment, room)}`;
}
